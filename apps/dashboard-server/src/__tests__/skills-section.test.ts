import { describe, it, expect } from 'vitest';
import { renderSkillsSection, MAX_SKILLS_SECTION_CHARS } from '../orchestrator/skills-section.js';
import type { Skill } from '../skills/types.js';
import type { SkillRegistry } from '../skills/registry.js';

function skill(name: string, systemPrompt: string): Skill {
  return {
    name,
    description: `${name} description`,
    model: 'sonnet',
    allowedTools: [],
    timeoutMs: 1000,
    systemPrompt,
    filePath: `/fake/${name}/SKILL.md`,
  };
}

function registryOf(...skills: Skill[]): Pick<SkillRegistry, 'get'> {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return { get: (name: string) => byName.get(name) };
}

describe('renderSkillsSection', () => {
  it('renders known skills in declared order under a ## Skills header', () => {
    const reg = registryOf(skill('alpha', 'Do A first.'), skill('beta', 'Then B.'));
    const out = renderSkillsSection(['beta', 'alpha'], reg);
    expect(out).toContain('## Skills');
    expect(out).toContain('### Skill: alpha\nDo A first.');
    expect(out).toContain('### Skill: beta\nThen B.');
    expect(out.indexOf('### Skill: beta')).toBeLessThan(out.indexOf('### Skill: alpha'));
  });

  it('skips unknown names silently and returns "" when none resolve', () => {
    const reg = registryOf(skill('alpha', 'A'));
    expect(renderSkillsSection(['nope', 'alpha'], reg)).toContain('### Skill: alpha');
    expect(renderSkillsSection(['nope', 'missing'], reg)).toBe('');
  });

  it('returns "" without a registry or with an empty name list', () => {
    expect(renderSkillsSection(['alpha'], undefined)).toBe('');
    expect(renderSkillsSection([], registryOf(skill('alpha', 'A')))).toBe('');
  });

  it('caps total content and names omitted skills', () => {
    const big = 'y'.repeat(MAX_SKILLS_SECTION_CHARS - 20);
    const reg = registryOf(skill('big', big), skill('small', 'tiny instructions'));
    const out = renderSkillsSection(['big', 'small'], reg);
    expect(out).toContain('### Skill: big');
    expect(out).not.toContain('### Skill: small');
    expect(out).toContain('Assigned but omitted for length: small');
  });

  it('skips skills with an empty body instead of rendering empty blocks', () => {
    const reg = registryOf(skill('empty', '   '), skill('real', 'Do the thing.'));
    const out = renderSkillsSection(['empty', 'real'], reg);
    expect(out).not.toContain('### Skill: empty');
    expect(out).toContain('### Skill: real');
  });
});
