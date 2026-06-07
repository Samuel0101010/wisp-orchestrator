import './setup.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { healthRoutes } from '../routes/health.js';
import { projectRoutes } from '../routes/projects.js';
import { createInterviewRouter } from '../routes/interview.js';
import { createPlansRouter } from '../routes/plans.js';
import type { RunAgentTurnResult } from '../routes/chat-engine.js';
import { runMigrations } from '../db/migrate.js';
import { seedAgents } from '../db/agents-seed.js';
import { sqlite } from '../db/index.js';
import type { HarnessEvent } from '@wisp/schemas';
import type { RunClaudeOpts } from '@wisp/orchestrator';

function noopRunner(_opts: RunClaudeOpts): AsyncIterable<HarnessEvent> {
  return (async function* () {
    yield {
      type: 'task.completed',
      payload: { taskId: _opts.taskId, outcome: 'pass', exitCode: 0 },
    };
  })();
}

interface ScriptedTurn extends Partial<RunAgentTurnResult> {
  text: string;
}

function makeTurnImpl(script: ScriptedTurn[]) {
  let i = 0;
  return async (): Promise<RunAgentTurnResult> => {
    const next = script[Math.min(i, script.length - 1)]!;
    i++;
    return {
      text: next.text,
      tokensIn: next.tokensIn ?? 50,
      tokensOut: next.tokensOut ?? 25,
      durationMs: next.durationMs ?? 200,
      failed: next.failed ?? null,
    };
  };
}

async function buildApp(
  turnImpl?: (args: unknown) => Promise<RunAgentTurnResult>,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors);
  await app.register(healthRoutes);
  await app.register(projectRoutes);
  await app.register(createPlansRouter({ runner: noopRunner }));
  await app.register(
    createInterviewRouter(
      turnImpl
        ? { turnImpl: turnImpl as Parameters<typeof createInterviewRouter>[0]['turnImpl'] }
        : {},
    ),
  );
  return app;
}

async function createProject(app: FastifyInstance, repoPath?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'brief-proj',
      goal: 'do the thing',
      repoPath: repoPath ?? '/tmp/no-such-dir-' + Date.now(),
    },
  });
  return res.json().id as string;
}

beforeAll(() => {
  runMigrations();
  seedAgents();
});

afterAll(() => {
  sqlite.close();
});

describe('interview routes', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('GET returns the auto-seeded brief and empty transcript right after project create', async () => {
    app = await buildApp();
    await app.ready();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/interview`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.brief).toBeTruthy();
    expect(body.brief.briefReady).toBe(false);
    expect(body.brief.completenessScore).toBe(0);
    expect(body.transcript).toEqual([]);
  });

  it('POST /start is idempotent — same brief id across calls', async () => {
    app = await buildApp();
    await app.ready();
    const projectId = await createProject(app);

    const a = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/interview/start`,
      })
    ).json();
    const b = (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/interview/start`,
      })
    ).json();
    expect(a.brief.id).toBe(b.brief.id);
    expect(a.threadId).toBe(b.threadId);
  });

  it('POST /message accumulates brief patches across turns', async () => {
    const turnImpl = makeTurnImpl([
      {
        text: 'Got it — web app for a team. What is the team size?\n\n<<BRIEF_PATCH>>\n{"platform":"web","completenessScore":25}\n<<END>>',
      },
      {
        text: 'Five people, noted. What is the design preference?\n\n<<BRIEF_PATCH>>\n{"targetAudience":"team of 5","completenessScore":50}\n<<END>>',
      },
    ]);
    app = await buildApp(turnImpl);
    await app.ready();
    const projectId = await createProject(app);

    const r1 = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/interview/message`,
      payload: { message: 'Eine Web-App für mein Team.' },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().brief.platform).toBe('web');
    expect(r1.json().brief.completenessScore).toBe(25);
    expect(r1.json().assistantMessage.content).toContain('Got it');
    expect(r1.json().assistantMessage.content).not.toContain('BRIEF_PATCH');

    const r2 = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/interview/message`,
      payload: { message: '5 Leute.' },
    });
    expect(r2.json().brief.targetAudience).toBe('team of 5');
    expect(r2.json().brief.completenessScore).toBe(50);
    expect(r2.json().brief.platform).toBe('web'); // sticky
  });

  it('POST /message — <<BRIEF_COMPLETE>> flips briefReady immediately', async () => {
    const turnImpl = makeTurnImpl([
      {
        text: 'I have everything I need.\n<<BRIEF_PATCH>>\n{"completenessScore":85,"successCriteria":"works"}\n<<END>>\n<<BRIEF_COMPLETE>>',
      },
    ]);
    app = await buildApp(turnImpl);
    await app.ready();
    const projectId = await createProject(app);

    const r = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/interview/message`,
      payload: { message: 'ship it' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().brief.briefReady).toBe(true);
    expect(r.json().shouldFinalize).toBe(true);
  });

  it('POST /message refuses once briefReady=true (409)', async () => {
    const turnImpl = makeTurnImpl([{ text: 'never reached' }]);
    app = await buildApp(turnImpl);
    await app.ready();
    const projectId = await createProject(app);
    sqlite
      .prepare(
        `UPDATE project_briefs SET brief_ready=1, completeness_score=100, updated_at=? WHERE project_id=?`,
      )
      .run(Date.now(), projectId);

    const r = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/interview/message`,
      payload: { message: 'more details' },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('brief_already_finalised');
  });

  it('POST /finalize writes docs/PRD.md into repoPath when present', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-prd-test-'));
    try {
      app = await buildApp();
      await app.ready();
      const projectId = await createProject(app, tmp);
      sqlite
        .prepare(
          `UPDATE project_briefs SET target_audience=?, platform=?, completeness_score=?, updated_at=? WHERE project_id=?`,
        )
        .run('developers', 'web', 80, Date.now(), projectId);

      const r = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/interview/finalize`,
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().brief.briefReady).toBe(true);
      // Finalizing always marks the brief 100% complete (F4).
      expect(r.json().brief.completenessScore).toBe(100);
      expect(r.json().prdPath).toBe('docs/PRD.md');
      const prd = fs.readFileSync(path.join(tmp, 'docs/PRD.md'), 'utf8');
      expect(prd).toContain('# brief-proj — Product Requirements');
      expect(prd).toContain('developers');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('POST /finalize auto-creates a missing repo dir + writes docs/PRD.md', async () => {
    app = await buildApp();
    await app.ready();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-prd-init-'));
    const repoPath = path.join(base, 'fresh-project'); // does not exist yet
    const projectId = await createProject(app, repoPath);
    try {
      const r = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/interview/finalize`,
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().brief.briefReady).toBe(true);
      expect(r.json().brief.completenessScore).toBe(100);
      // The repo is now created + git-inited at finalize, so the PRD lands
      // instead of being dropped with a repo_path_missing warning.
      expect(r.json().prdPath).toBe('docs/PRD.md');
      expect(r.json().prdWriteError).toBeNull();
      expect(fs.existsSync(path.join(repoPath, '.git'))).toBe(true);
      expect(fs.existsSync(path.join(repoPath, 'docs', 'PRD.md'))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('PATCH /interview allows direct field edits', async () => {
    app = await buildApp();
    await app.ready();
    const projectId = await createProject(app);

    const r = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/interview`,
      payload: { targetAudience: 'devs', completenessScore: 50 },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().brief.targetAudience).toBe('devs');
    expect(r.json().brief.completenessScore).toBe(50);
  });
});

describe('planner brief gate', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  async function setupProjectWithTeam(): Promise<{ app: FastifyInstance; projectId: string }> {
    app = await buildApp();
    await app.ready();
    const projectId = await createProject(app);
    const filler = 'x'.repeat(80);
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: {
        roles: [
          { role: 'architect', model: 'opus', allowedTools: ['Read'], systemPrompt: `a ${filler}` },
          {
            role: 'developer',
            model: 'sonnet',
            allowedTools: ['Read'],
            systemPrompt: `d ${filler}`,
          },
        ],
      },
    });
    return { app, projectId };
  }

  it('POST /plan returns 412 when briefReady=false', async () => {
    const { app, projectId } = await setupProjectWithTeam();
    const r = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/plan`,
      payload: {},
    });
    expect(r.statusCode).toBe(412);
    expect(r.json().error).toBe('brief_not_ready');
    expect(r.json().completenessScore).toBe(0);
  });

  it('POST /plan accepts X-Allow-Unbriefed header even without a finalised brief', async () => {
    const { app, projectId } = await setupProjectWithTeam();
    const r = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/plan`,
      payload: {},
      headers: { 'x-allow-unbriefed': '1' },
    });
    // Status will be 422 (plan_generation_failed) because the no-op runner
    // never writes a plan — but importantly NOT 412. The gate let us through.
    expect(r.statusCode).not.toBe(412);
  });

  it('both create paths auto-seed the brief row (manual POST /api/projects)', async () => {
    app = await buildApp();
    await app.ready();
    const projectId = await createProject(app);
    const get = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/interview`,
    });
    expect(get.json().brief).toBeTruthy();
    expect(get.json().brief.briefReady).toBe(false);
  });
});
