import './setup.js';
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { buildTranscript, summarizeRun } from '../run-summary/summarizer.js';
import { db, sqlite } from '../db/index.js';
import { runs, plans, projects, teams, events, runSummaries } from '@agent-harness/schemas';
import { runMigrations } from '../db/migrate.js';
import { SkillRegistry } from '../skills/registry.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubprocessRunner } from '@agent-harness/orchestrator';

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  sqlite.prepare('DELETE FROM run_summaries').run();
  sqlite.prepare('DELETE FROM events').run();
  sqlite.prepare('DELETE FROM runs').run();
  sqlite.prepare('DELETE FROM plans').run();
  sqlite.prepare('DELETE FROM teams').run();
  sqlite.prepare('DELETE FROM projects').run();
});

async function seedRunWithEvents(): Promise<{ runId: string; projectId: string }> {
  const projectId = randomUUID();
  const planId = randomUUID();
  const runId = randomUUID();
  await db
    .insert(projects)
    .values({ id: projectId, name: 'p', goal: 'g', repoPath: '/tmp/r', createdAt: new Date() })
    .run();
  await db
    .insert(teams)
    .values({ id: randomUUID(), projectId, rolesJson: { roles: [] } })
    .run();
  await db
    .insert(plans)
    .values({ id: planId, projectId, dagJson: { tasks: [], edges: [] }, status: 'locked' })
    .run();
  await db
    .insert(runs)
    .values({
      id: runId,
      planId,
      status: 'completed',
      outcome: 'success',
      budgetMinutes: 60,
      budgetTurns: 100,
      maxParallel: 1,
      tokensInTotal: 100,
      tokensOutTotal: 200,
      turnsTotal: 3,
    })
    .run();
  await db
    .insert(events)
    .values([
      {
        id: randomUUID(),
        runId,
        type: 'run.started',
        payload: {},
        ts: new Date(Date.now() - 3000),
      },
      {
        id: randomUUID(),
        runId,
        type: 'task.text-delta',
        payload: { text: 'fixing the login bug' },
        ts: new Date(Date.now() - 2000),
      },
      {
        id: randomUUID(),
        runId,
        type: 'task.completed',
        payload: { outcome: 'pass' },
        ts: new Date(Date.now() - 1000),
      },
    ])
    .run();
  return { runId, projectId };
}

describe('buildTranscript', () => {
  it('produces a string under 24KB for typical runs', async () => {
    const { runId } = await seedRunWithEvents();
    const transcript = buildTranscript(runId);
    expect(transcript.length).toBeGreaterThan(0);
    expect(transcript.length).toBeLessThan(24_000);
    expect(transcript).toContain('task.text-delta');
  });
});

describe('summarizeRun', () => {
  it('persists a run_summaries row with summary text', async () => {
    const { runId, projectId } = await seedRunWithEvents();

    const root = mkdtempSync(join(tmpdir(), 'sum-skills-'));
    mkdirSync(join(root, 'summarize-thread'), { recursive: true });
    writeFileSync(
      join(root, 'summarize-thread/SKILL.md'),
      `---
name: summarize-thread
description: Test
model: haiku
allowed-tools: []
---
test`,
    );
    const reg = new SkillRegistry(root);
    reg.init();

    async function* mockRunner(opts: { taskId: string }) {
      yield {
        type: 'task.text-delta',
        payload: {
          taskId: opts.taskId,
          text: '- Decisions: shipped login fix\n- Action items: none\n- Open questions: none\n- Context preserved: bug-123 closed\n- Last activity: completed',
        },
      } as const;
      yield {
        type: 'task.usage',
        payload: { taskId: opts.taskId, tokensIn: 50, tokensOut: 100, turns: 1 },
      } as const;
      yield {
        type: 'task.completed',
        payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
      } as const;
    }

    await summarizeRun({
      runId,
      projectId,
      registry: reg,
      runner: mockRunner as unknown as SubprocessRunner,
    });

    const stored = db.select().from(runSummaries).get();
    expect(stored).toBeDefined();
    expect(stored?.runId).toBe(runId);
    expect(stored?.summaryMd).toContain('Decisions');
  });

  it('is idempotent — second call does not overwrite', async () => {
    const { runId, projectId } = await seedRunWithEvents();
    const root = mkdtempSync(join(tmpdir(), 'sum-skills-2-'));
    mkdirSync(join(root, 'summarize-thread'), { recursive: true });
    writeFileSync(
      join(root, 'summarize-thread/SKILL.md'),
      `---
name: summarize-thread
description: Test
model: haiku
allowed-tools: []
---
test`,
    );
    const reg = new SkillRegistry(root);
    reg.init();
    let calls = 0;
    async function* mockRunner(opts: { taskId: string }) {
      calls++;
      yield {
        type: 'task.text-delta',
        payload: { taskId: opts.taskId, text: `summary ${calls}` },
      } as const;
      yield {
        type: 'task.completed',
        payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
      } as const;
    }
    await summarizeRun({
      runId,
      projectId,
      registry: reg,
      runner: mockRunner as unknown as SubprocessRunner,
    });
    await summarizeRun({
      runId,
      projectId,
      registry: reg,
      runner: mockRunner as unknown as SubprocessRunner,
    });
    expect(calls).toBe(1);
  });
});

import { getLatestSummaryForProject } from '../run-summary/retrieve.js';

describe('getLatestSummaryForProject', () => {
  it('returns the newest summary for a project', async () => {
    const projectId = randomUUID();
    await db
      .insert(projects)
      .values({ id: projectId, name: 'p', goal: 'g', repoPath: '/tmp/r', createdAt: new Date() })
      .run();
    const planId = randomUUID();
    await db
      .insert(plans)
      .values({ id: planId, projectId, dagJson: { tasks: [], edges: [] }, status: 'locked' })
      .run();
    const runIdOld = randomUUID();
    const runIdNew = randomUUID();
    await db
      .insert(runs)
      .values([
        {
          id: runIdOld,
          planId,
          status: 'completed',
          outcome: 'success',
          budgetMinutes: 60,
          budgetTurns: 100,
          maxParallel: 1,
          tokensInTotal: 0,
          tokensOutTotal: 0,
          turnsTotal: 0,
        },
        {
          id: runIdNew,
          planId,
          status: 'completed',
          outcome: 'success',
          budgetMinutes: 60,
          budgetTurns: 100,
          maxParallel: 1,
          tokensInTotal: 0,
          tokensOutTotal: 0,
          turnsTotal: 0,
        },
      ])
      .run();
    await db
      .insert(runSummaries)
      .values([
        {
          runId: runIdOld,
          projectId,
          summaryMd: 'old',
          mode: null,
          tokensTotal: 0,
          createdAt: new Date(Date.now() - 60_000),
        },
        {
          runId: runIdNew,
          projectId,
          summaryMd: 'new',
          mode: null,
          tokensTotal: 0,
          createdAt: new Date(),
        },
      ])
      .run();
    const latest = getLatestSummaryForProject(projectId);
    expect(latest?.summaryMd).toBe('new');
  });
});
