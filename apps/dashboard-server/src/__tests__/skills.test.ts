import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from '../skills/registry.js';

function fixtureSkill(rootDir: string, name: string, body: string): void {
  const dir = join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---
name: ${name}
description: Test skill ${name}
model: haiku
allowed-tools: ["Read","Edit"]
---
You are a test skill body.
${body}
`,
  );
}

describe('SkillRegistry', () => {
  it('loads skills on init and returns by name', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'));
    fixtureSkill(root, 'foo', 'foo body');
    fixtureSkill(root, 'bar', 'bar body');
    const reg = new SkillRegistry(root);
    reg.init();
    expect(
      reg
        .list()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['bar', 'foo']);
    expect(reg.get('foo')?.systemPrompt).toContain('foo body');
  });

  it('returns undefined for unknown skill', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'));
    const reg = new SkillRegistry(root);
    reg.init();
    expect(reg.get('does-not-exist')).toBeUndefined();
  });
});

import { invokeSkill } from '../skills/invoker.js';
import type { RunClaudeOpts } from '@agent-harness/orchestrator';
import type { HarnessEvent } from '@agent-harness/schemas';

describe('invokeSkill', () => {
  it('runs the skill body as systemPrompt with the given args as user prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'));
    fixtureSkill(root, 'echo', 'echo body');
    const reg = new SkillRegistry(root);
    reg.init();
    const captured: RunClaudeOpts[] = [];
    async function* mockRunner(opts: RunClaudeOpts): AsyncGenerator<HarnessEvent> {
      captured.push(opts);
      yield { type: 'task.text-delta', payload: { taskId: opts.taskId, text: 'OK' } };
      yield {
        type: 'task.usage',
        payload: { taskId: opts.taskId, tokensIn: 1, tokensOut: 1, turns: 1 },
      };
      yield {
        type: 'task.completed',
        payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
      };
    }
    const result = await invokeSkill({
      registry: reg,
      name: 'echo',
      args: 'hello',
      runner: mockRunner,
    });
    expect(result.failed).toBeNull();
    expect(result.text).toBe('OK');
    expect(captured[0].systemPrompt).toContain('echo body');
    expect(captured[0].prompt).toBe('hello');
    expect(captured[0].allowedTools).toEqual(['Read', 'Edit']);
    expect(result.skillName).toBe('echo');
  });

  it('returns failed="skill_not_found" if name unknown', async () => {
    const reg = new SkillRegistry(mkdtempSync(join(tmpdir(), 'skills-')));
    reg.init();
    const result = await invokeSkill({ registry: reg, name: 'nope', args: '' });
    expect(result.failed).toBe('skill_not_found');
  });
});

import { buildManagerSystemPrompt } from '../routes/chat.js';

describe('buildManagerSystemPrompt', () => {
  it('returns base unchanged when registry is undefined', () => {
    expect(buildManagerSystemPrompt('base', undefined)).toBe('base');
  });

  it('returns base unchanged when registry is empty', () => {
    const reg = new SkillRegistry(mkdtempSync(join(tmpdir(), 'skills-')));
    reg.init();
    expect(buildManagerSystemPrompt('base', reg)).toBe('base');
  });

  it('appends ## Available skills block with skill names when registry is non-empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'));
    fixtureSkill(root, 'summarise', 'Summarise body');
    const reg = new SkillRegistry(root);
    reg.init();
    const result = buildManagerSystemPrompt('You are the manager.', reg);
    expect(result).toContain('You are the manager.');
    expect(result).toContain('## Available skills');
    expect(result).toContain('- summarise: Test skill summarise');
    expect(result).toContain('invoke_skill');
  });
});
