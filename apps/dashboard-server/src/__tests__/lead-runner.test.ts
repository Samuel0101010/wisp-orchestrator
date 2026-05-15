import './setup.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  leadNotes as leadNotesTable,
  projectBriefs,
  projects as projectsTable,
  projectStates,
} from '@agent-harness/schemas';
import type { RunAgentTurnResult } from '../routes/chat-engine.js';
import { runLeadTick } from '../orchestrator/lead-runner.js';
import { runMigrations } from '../db/migrate.js';
import { seedAgents } from '../db/agents-seed.js';
import { db, sqlite } from '../db/index.js';

beforeAll(() => {
  runMigrations();
  seedAgents();
});

afterAll(() => {
  sqlite.close();
});

function seedProject(opts: { leadEnabled?: boolean } = {}): string {
  const id = randomUUID();
  db.insert(projectsTable)
    .values({
      id,
      name: 'lead-test',
      goal: 'Build a tiny calculator',
      repoPath: '/tmp/lead-test-' + id,
      createdAt: new Date(),
      leadEnabled: opts.leadEnabled ?? true,
    })
    .run();
  return id;
}

function seedBrief(projectId: string, opts: { ready?: boolean } = {}): void {
  db.insert(projectBriefs)
    .values({
      id: randomUUID(),
      projectId,
      targetAudience: 'engineers',
      successCriteria: 'works',
      designPrefs: 'minimal',
      platform: 'web',
      constraints: 'no deps',
      completenessScore: opts.ready ? 90 : 30,
      briefReady: opts.ready ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}

function makeTurnImpl(text: string): (args: unknown) => Promise<RunAgentTurnResult> {
  return async () => ({
    text,
    tokensIn: 100,
    tokensOut: 50,
    durationMs: 250,
    failed: null,
  });
}

describe('runLeadTick', () => {
  it('happy path: composes prompt, parses decision, persists row', async () => {
    const projectId = seedProject();
    seedBrief(projectId, { ready: true });
    db.insert(projectStates)
      .values({
        id: randomUUID(),
        projectId,
        runId: null,
        stateMd: 'docs/project-state.md',
        completedFeatures: ['login'],
        openTodos: ['signup'],
        knownIssues: [],
        architectureSnapshot: null,
        createdAt: new Date(),
      })
      .run();

    let capturedPrompt = '';
    let capturedSystemPrompt = '';
    const turnImpl = async (args: {
      prompt: string;
      systemPrompt: string;
    }): Promise<RunAgentTurnResult> => {
      capturedPrompt = args.prompt;
      capturedSystemPrompt = args.systemPrompt;
      return {
        text: 'The team finished login and the brief is ready. Signup is the next slice.\n\n<<LEAD_DECISION>>\n{"nextRole":"frontend-dev","reasoning":"Build signup UI","blockers":[],"recommendedAction":"continue"}\n<<END>>',
        tokensIn: 200,
        tokensOut: 80,
        durationMs: 333,
        failed: null,
      };
    };

    const result = await runLeadTick({ projectId, turnImpl });
    expect(result.parseError).toBeNull();
    expect(result.decision?.nextRole).toBe('frontend-dev');
    expect(result.decision?.recommendedAction).toBe('continue');
    expect(result.summary).toContain('login');
    expect(result.summary).not.toContain('<<LEAD_DECISION>>');

    // Prompt composed with expected sections.
    expect(capturedPrompt).toContain('## Project goal');
    expect(capturedPrompt).toContain('## Brief');
    expect(capturedPrompt).toContain('## Current state');
    expect(capturedPrompt).toContain('## Last run summary');
    expect(capturedPrompt).toContain('## Open change requests');
    expect(capturedPrompt).toContain('## Prior handoffs');
    expect(capturedPrompt).toContain('## Prior lead notes');
    // System prompt comes from the seeded Theo agent.
    expect(capturedSystemPrompt).toContain('Theo');

    // Row persisted.
    const rows = db
      .select()
      .from(leadNotesTable)
      .where(eq(leadNotesTable.projectId, projectId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summaryMd).toContain('login');
    expect(rows[0]!.decisionsJson?.recommendedAction).toBe('continue');
  });

  it('parseError path: persists note with null decisions_json', async () => {
    const projectId = seedProject();
    seedBrief(projectId);

    const turnImpl = makeTurnImpl('Some narrative.\n\n<<LEAD_DECISION>>\n{nope not json}\n<<END>>');
    const result = await runLeadTick({ projectId, turnImpl });
    expect(result.decision).toBeNull();
    expect(result.parseError).toMatch(/invalid_lead_decision_json/);

    const rows = db
      .select()
      .from(leadNotesTable)
      .where(eq(leadNotesTable.projectId, projectId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decisionsJson).toBeNull();
    expect(rows[0]!.summaryMd).toContain('Some narrative');
  });

  it('empty project (no brief, no state) still composes a sensible prompt', async () => {
    const projectId = seedProject();
    let capturedPrompt = '';
    const turnImpl = async (args: { prompt: string }): Promise<RunAgentTurnResult> => {
      capturedPrompt = args.prompt;
      return {
        text: 'Brief is missing — wait for the user to finish the interview.\n\n<<LEAD_DECISION>>\n{"recommendedAction":"wait-for-user","nextRole":"requirements-interviewer","blockers":["brief missing"]}\n<<END>>',
        tokensIn: 80,
        tokensOut: 40,
        durationMs: 100,
        failed: null,
      };
    };
    const result = await runLeadTick({ projectId, turnImpl });
    expect(result.decision?.recommendedAction).toBe('wait-for-user');
    // Empty-section markers present.
    expect(capturedPrompt).toContain('_(no brief row)_');
    expect(capturedPrompt).toContain('_(no project-state snapshot yet)_');
    expect(capturedPrompt).toContain('_(no runs yet)_');
  });

  it('throws project_not_found when projectId is unknown', async () => {
    await expect(
      runLeadTick({
        projectId: 'does-not-exist',
        turnImpl: makeTurnImpl('hi'),
      }),
    ).rejects.toThrow(/project_not_found/);
  });
});
