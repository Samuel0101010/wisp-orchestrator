/**
 * Unit tests for the invoke_skill directive handler.
 *
 * Simplified scope: calls executeDirective directly with an in-memory
 * SkillRegistry and a mock runner — skips the Fastify+DB layer that is
 * already covered by chat-v2.test.ts.
 *
 * The DB interaction (INSERT INTO agent_messages) is live because the
 * test setup module configures a temp HARNESS_DATA_DIR and seeds the DB.
 */
import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent } from '@agent-harness/schemas';
import type { RunClaudeOpts } from '@agent-harness/orchestrator';
import { SkillRegistry } from '../skills/registry.js';
import { executeDirective } from '../routes/chat-directives.js';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';
import { seedAgents } from '../db/agents-seed.js';

function makeSkillRegistry(name: string, description: string, output: string): SkillRegistry {
  const root = mkdtempSync(join(tmpdir(), 'skill-dir-'));
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\nmodel: haiku\nallowed-tools: []\n---\n${output}\n`,
  );
  const reg = new SkillRegistry(root);
  reg.init();
  return reg;
}

function makeFixedRunner(text: string) {
  return async function* (opts: RunClaudeOpts): AsyncGenerator<HarnessEvent> {
    yield { type: 'task.text-delta', payload: { taskId: opts.taskId, text } };
    yield {
      type: 'task.usage',
      payload: { taskId: opts.taskId, tokensIn: 3, tokensOut: 5, turns: 1 },
    };
    yield {
      type: 'task.completed',
      payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
    };
  };
}

function makeThreadAndManagerMessage(): {
  threadId: string;
  managerMessageId: string;
  managerId: string;
} {
  const threadId = crypto.randomUUID();
  const managerMessageId = crypto.randomUUID();

  // Look up the seeded manager agent id
  const manager = sqlite
    .prepare<unknown[], { id: string }>(`SELECT id FROM agents WHERE seed_key = 'manager' LIMIT 1`)
    .get();
  if (!manager) throw new Error('manager seed not found');

  // Insert a minimal thread + manager message for FK constraints
  sqlite
    .prepare(
      `INSERT INTO agent_threads (id, agent_id, title, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`,
    )
    .run(threadId, manager.id, Date.now(), Date.now());
  sqlite
    .prepare(
      `INSERT INTO agent_messages (id, thread_id, role, content, created_at) VALUES (?, ?, 'assistant', '', ?)`,
    )
    .run(managerMessageId, threadId, Date.now());

  return { threadId, managerMessageId, managerId: manager.id };
}

describe('executeDirective — invoke_skill', () => {
  beforeAll(() => {
    runMigrations();
    seedAgents();
  });

  afterAll(() => {
    sqlite.close();
  });

  it('runs the named skill and returns an ExecutedDirective with kind=invoke_skill and extraMessages', async () => {
    const registry = makeSkillRegistry('summarise', 'Summarise text', 'You summarise text.');
    const runner = makeFixedRunner('Short summary here.');
    const { threadId, managerMessageId } = makeThreadAndManagerMessage();

    const result = await executeDirective(
      { kind: 'invoke_skill', name: 'summarise', args: 'Long text goes here' },
      { threadId, managerMessageId, runner, skillRegistry: registry },
    );

    expect(result.kind).toBe('invoke_skill');
    expect(result.status).toBe('ok');
    expect(result.extraMessages).toHaveLength(1);
    expect(result.extraMessages[0].content).toBe('Short summary here.');
    expect(result.extraMessages[0].role).toBe('assistant');
    const r = result.result as { skillName: string; failed: string | null };
    expect(r.skillName).toBe('summarise');
    expect(r.failed).toBeNull();
  });

  it('fails with status=failed when skill is not found in registry', async () => {
    const registry = makeSkillRegistry('other', 'Other skill', 'Other body.');
    const { threadId, managerMessageId } = makeThreadAndManagerMessage();

    const result = await executeDirective(
      { kind: 'invoke_skill', name: 'nonexistent', args: '' },
      { threadId, managerMessageId, skillRegistry: registry },
    );

    expect(result.kind).toBe('invoke_skill');
    expect(result.status).toBe('failed');
    expect((result.result as { error: string }).error).toContain('unknown_skill');
  });

  it('fails with status=failed when no skillRegistry is provided', async () => {
    const { threadId, managerMessageId } = makeThreadAndManagerMessage();

    const result = await executeDirective(
      { kind: 'invoke_skill', name: 'summarise', args: '' },
      { threadId, managerMessageId },
    );

    expect(result.status).toBe('failed');
    expect((result.result as { error: string }).error).toContain('skills_not_configured');
  });
});

describe('buildManagerSystemPrompt', () => {
  it('returns base unchanged when no registry provided', async () => {
    const { buildManagerSystemPrompt } = await import('../routes/chat.js');
    expect(buildManagerSystemPrompt('base prompt', undefined)).toBe('base prompt');
  });

  it('returns base unchanged when registry is empty', async () => {
    const { buildManagerSystemPrompt } = await import('../routes/chat.js');
    const root = mkdtempSync(join(tmpdir(), 'skills-empty-'));
    const reg = new SkillRegistry(root);
    reg.init();
    expect(buildManagerSystemPrompt('base prompt', reg)).toBe('base prompt');
  });

  it('appends skill list to system prompt when registry has skills', async () => {
    const { buildManagerSystemPrompt } = await import('../routes/chat.js');
    const registry = makeSkillRegistry('echo', 'Echoes input', 'Echo body.');
    const result = buildManagerSystemPrompt('base prompt', registry);
    expect(result).toContain('base prompt');
    expect(result).toContain('## Available skills');
    expect(result).toContain('echo');
    expect(result).toContain('Echoes input');
    expect(result).toContain('invoke_skill');
  });
});
