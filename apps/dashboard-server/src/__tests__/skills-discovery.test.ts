import './setup.js';
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills } from '../skills/discovery.js';

function makeSkillFile(dir: string, name: string, model = 'haiku'): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    `---
name: ${name}
description: Test skill ${name}
model: ${model}
allowed-tools: ["Read"]
---
Body of ${name}.
`,
  );
}

describe('discoverSkills', () => {
  let home: string;
  let project: string;
  let seedRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'discover-home-'));
    project = mkdtempSync(join(tmpdir(), 'discover-project-'));
    seedRoot = mkdtempSync(join(tmpdir(), 'discover-seed-'));
    // Layout under the fake home:
    //   <home>/.claude/skills/                 → user-source skills
    //   <home>/.claude/plugins/cache/.../skills → plugin-source skills
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(home, '.claude', 'plugins', 'cache'), { recursive: true });
    // Project layout:
    //   <project>/.claude/skills/              → project-source skills
    mkdirSync(join(project, '.claude', 'skills'), { recursive: true });
  });

  it('loads skills from all four sources and tags them by origin', () => {
    makeSkillFile(seedRoot, 'doctor');
    makeSkillFile(join(project, '.claude', 'skills'), 'audit');
    makeSkillFile(join(home, '.claude', 'skills'), 'higgsfield-generate');
    // Plugin: <home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>/SKILL.md
    const pluginSkills = join(
      home,
      '.claude',
      'plugins',
      'cache',
      'official-marketplace',
      'superpowers',
      '5.1.0',
      'skills',
    );
    mkdirSync(pluginSkills, { recursive: true });
    makeSkillFile(pluginSkills, 'brainstorming');

    const { skills, stats } = discoverSkills({ seedRoot, projectRoot: project, homeDir: home });

    expect(stats.loaded).toBe(4);
    expect(stats.shadowed).toHaveLength(0);

    const bySource = Object.fromEntries(skills.map((s) => [s.name, s.source]));
    expect(bySource.doctor).toBe('seed');
    expect(bySource.audit).toBe('project');
    expect(bySource['higgsfield-generate']).toBe('user');
    expect(bySource.brainstorming).toBe('plugin:superpowers');
  });

  it('first source wins on a name collision (seed > project > user > plugin)', () => {
    makeSkillFile(seedRoot, 'doctor', 'opus');
    makeSkillFile(join(project, '.claude', 'skills'), 'doctor', 'sonnet');
    makeSkillFile(join(home, '.claude', 'skills'), 'doctor', 'haiku');

    const { skills, stats } = discoverSkills({ seedRoot, projectRoot: project, homeDir: home });

    const doctor = skills.find((s) => s.name === 'doctor')!;
    expect(doctor.source).toBe('seed');
    expect(doctor.model).toBe('opus');
    expect(stats.shadowed.map((s) => s.source)).toEqual(['project', 'user']);
  });

  it('picks the lexically-greatest version per plugin', () => {
    const pluginBase = join(home, '.claude', 'plugins', 'cache', 'm1', 'superpowers');
    for (const version of ['5.0.0', '5.1.0', '4.9.9']) {
      const vDir = join(pluginBase, version, 'skills');
      mkdirSync(vDir, { recursive: true });
      makeSkillFile(vDir, `marker-${version.replace(/\./g, '_')}`);
    }

    const { skills } = discoverSkills({ seedRoot, homeDir: home });

    // Only the highest version's skills should appear.
    const names = skills.map((s) => s.name);
    expect(names).toContain('marker-5_1_0');
    expect(names).not.toContain('marker-5_0_0');
    expect(names).not.toContain('marker-4_9_9');
  });

  it('skips sources that do not exist on disk', () => {
    makeSkillFile(seedRoot, 'doctor');
    // No project, no user-skills dir, no plugin cache content.
    const { skills, stats } = discoverSkills({
      seedRoot,
      projectRoot: '/no/such/project',
      homeDir: '/no/such/home',
    });
    expect(skills.map((s) => s.name)).toEqual(['doctor']);
    expect(stats.shadowed).toHaveLength(0);
  });

  it('SkillRegistry consumes discovered skills via the discoveryOpts constructor', async () => {
    makeSkillFile(seedRoot, 'doctor');
    makeSkillFile(join(home, '.claude', 'skills'), 'find-skills');
    const { SkillRegistry } = await import('../skills/registry.js');
    const reg = new SkillRegistry({ discoveryOpts: { seedRoot, homeDir: home } });
    reg.init();
    const list = reg.list();
    expect(list.map((s) => s.name).sort()).toEqual(['doctor', 'find-skills']);
    expect(reg.get('find-skills')?.source).toBe('user');
  });
});
