import './setup.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { directiveSchema, plans, type HarnessEvent } from '@wisp/schemas';
import type { RunClaudeOpts } from '@wisp/orchestrator';
import { agentRoutes } from '../routes/agents.js';
import { createChatRouter } from '../routes/chat.js';
import { projectRoutes } from '../routes/projects.js';
import { createPlansRouter } from '../routes/plans.js';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';
import { seedAgents } from '../db/agents-seed.js';
import { env } from '../env.js';

/**
 * Build a runner that returns whatever text we tell it to. Used to fake the
 * Manager's directive output and the consulted specialist's reply.
 */
function makeProgrammableRunner(scripts: Map<string, string>) {
  return async function* runner(opts: RunClaudeOpts): AsyncGenerator<HarnessEvent> {
    // Find the first script whose key occurs in the prompt OR taskId.
    let chosen: string | undefined;
    for (const [match, reply] of scripts) {
      if (opts.taskId.includes(match) || opts.prompt.includes(match)) {
        chosen = reply;
        break;
      }
    }
    if (chosen === undefined) chosen = '(no script matched)';
    yield { type: 'task.text-delta', payload: { taskId: opts.taskId, text: chosen } };
    yield {
      type: 'task.usage',
      payload: { taskId: opts.taskId, tokensIn: 10, tokensOut: 5, turns: 1 },
    };
    yield {
      type: 'task.completed',
      payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
    };
  };
}

/**
 * Runner that sleeps before yielding — lets a test hold the per-thread send
 * lock open long enough for a second concurrent request to collide with it.
 */
function makeSlowRunner(delayMs: number, reply: string) {
  return async function* runner(opts: RunClaudeOpts): AsyncGenerator<HarnessEvent> {
    await new Promise((r) => setTimeout(r, delayMs));
    yield { type: 'task.text-delta', payload: { taskId: opts.taskId, text: reply } };
    yield {
      type: 'task.usage',
      payload: { taskId: opts.taskId, tokensIn: 10, tokensOut: 5, turns: 1 },
    };
    yield {
      type: 'task.completed',
      payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
    };
  };
}

async function buildAppWithRunner(
  scripts: Map<string, string> = new Map(),
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(agentRoutes);
  await app.register(projectRoutes);
  await app.register(createPlansRouter({}));
  await app.register(createChatRouter({ runner: makeProgrammableRunner(scripts) }));
  await app.ready();
  return app;
}

async function getManagerId(app: FastifyInstance): Promise<string> {
  const all = await app.inject({ method: 'GET', url: '/api/agents' });
  const list = all.json() as Array<{ id: string; seedKey: string | null }>;
  const m = list.find((a) => a.seedKey === 'manager');
  if (!m) throw new Error('manager seed not present — did seedAgents() run?');
  return m.id;
}

/**
 * Seed a project + a (minimal) team row directly via SQL — bypasses the
 * create_project directive so the generate_plan handler's eager validation
 * (project exists + team exists) passes without going through chat. Returns
 * the new projectId.
 */
function seedProjectWithTeam(name = 'PlanProj'): string {
  const projectId = randomUUID();
  const teamId = randomUUID();
  const now = Date.now();
  sqlite
    .prepare(`INSERT INTO projects (id, name, goal, repo_path, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(projectId, name, `goal for ${name}`, `C:/tmp/${name}`, now);
  sqlite
    .prepare(`INSERT INTO teams (id, project_id, roles_json) VALUES (?, ?, ?)`)
    .run(teamId, projectId, JSON.stringify({ roles: [] }));
  return projectId;
}

/** Read the most-recent chat_actions row for a thread (or one of a kind). */
function readAction(
  threadId: string,
  kind?: string,
): { id: string; kind: string; status: string; result_json: string | null } | undefined {
  const rows = sqlite
    .prepare(
      `SELECT id, kind, status, result_json FROM chat_actions
       WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC`,
    )
    .all(threadId) as Array<{
    id: string;
    kind: string;
    status: string;
    result_json: string | null;
  }>;
  return kind ? rows.find((r) => r.kind === kind) : rows[0];
}

/** Create a manager-owned thread and return its id. */
async function newManagerThread(app: FastifyInstance): Promise<string> {
  const managerId = await getManagerId(app);
  const t = await app.inject({
    method: 'POST',
    url: `/api/agents/${managerId}/threads`,
    payload: {},
  });
  return (t.json() as { id: string }).id;
}

/** Build the manager <<ACTION>> reply wrapping a JSON directive. */
function directiveReply(prose: string, json: string): string {
  return `${prose}\n\n<<ACTION>>\n${json}\n<<END>>`;
}

describe('chat v2 — participants, @mentions, directives, compress', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    runMigrations();
    seedAgents(); // installs the 10-agent built-in team
  });

  afterAll(async () => {
    await app?.close();
    sqlite.close();
  });

  it('thread created on a manager agent auto-adds them as participant=manager', async () => {
    app = await buildAppWithRunner();
    const managerId = await getManagerId(app);

    const t = await app.inject({
      method: 'POST',
      url: `/api/agents/${managerId}/threads`,
      payload: {},
    });
    expect(t.statusCode).toBe(201);
    const threadId = (t.json() as { id: string }).id;

    const parts = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/participants`,
    });
    expect(parts.statusCode).toBe(200);
    const list = parts.json() as Array<{ agentId: string; role: string; seedKey: string }>;
    expect(list).toHaveLength(1);
    expect(list[0].agentId).toBe(managerId);
    expect(list[0].role).toBe('manager');
    expect(list[0].seedKey).toBe('manager');
  });

  it('POST/DELETE /participants adds and removes members; cannot remove manager', async () => {
    const managerId = await getManagerId(app);
    const all = await app.inject({ method: 'GET', url: '/api/agents' });
    const list = all.json() as Array<{ id: string; seedKey: string | null }>;
    const lena = list.find((a) => a.seedKey === 'frontend-dev');
    expect(lena).toBeDefined();

    const t = await app.inject({
      method: 'POST',
      url: `/api/agents/${managerId}/threads`,
      payload: {},
    });
    const threadId = (t.json() as { id: string }).id;

    // add
    const add = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/participants`,
      payload: { agentId: lena!.id },
    });
    expect(add.statusCode).toBe(201);

    // duplicate add → 409
    const dup = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/participants`,
      payload: { agentId: lena!.id },
    });
    expect(dup.statusCode).toBe(409);

    // can't remove manager
    const removeMgr = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${threadId}/participants/${managerId}`,
    });
    expect(removeMgr.statusCode).toBe(409);

    // remove member → 204
    const rm = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${threadId}/participants/${lena!.id}`,
    });
    expect(rm.statusCode).toBe(204);
  });

  it('routes the message to the @mentioned participant when present', async () => {
    app = await buildAppWithRunner(
      new Map([
        ['frontend-dev', 'I am Lena and I would suggest a small reusable hook.'],
        ['manager', 'I am Marcus the manager.'],
      ]),
    );
    const managerId = await getManagerId(app);
    const all = await app.inject({ method: 'GET', url: '/api/agents' });
    const list = all.json() as Array<{ id: string; seedKey: string | null; name: string }>;
    const lena = list.find((a) => a.seedKey === 'frontend-dev')!;

    const t = await app.inject({
      method: 'POST',
      url: `/api/agents/${managerId}/threads`,
      payload: {},
    });
    const threadId = (t.json() as { id: string }).id;
    await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/participants`,
      payload: { agentId: lena.id },
    });

    const send = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@Lena what do you think about React server components?' },
    });
    expect(send.statusCode).toBe(201);
    const body = send.json();
    expect(body.assistants[0].content).toContain('Lena');
    expect(body.assistants[0].authorAgentId).toBe(lena.id);
  });

  it('manager directive consult posts a second assistant message from the consulted specialist', async () => {
    app = await buildAppWithRunner(
      new Map([
        // More specific first: consult sub-call's taskId is `chat-consult-…`.
        ['consult', 'Use pgvector with HNSW; 1M rows fit in <2GB and queries stay sub-100ms.'],
        // Manager reply matches the broader `chat-` prefix; triggers consult.
        [
          'chat-',
          'Sure, let me ask Diego.\n\n<<ACTION>>\n{"kind":"consult","agent":"backend-dev","question":"What\'s the cheapest way to store 1M embeddings?"}\n<<END>>',
        ],
      ]),
    );
    const managerId = await getManagerId(app);

    const t = await app.inject({
      method: 'POST',
      url: `/api/agents/${managerId}/threads`,
      payload: {},
    });
    const threadId = (t.json() as { id: string }).id;
    const send = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: 'Where should we store embeddings?' },
    });
    expect(send.statusCode).toBe(201);
    const body = send.json();

    // Manager's primary message (with the directive stripped from prose)
    expect(body.assistants[0].content).toContain('Sure, let me ask Diego');
    expect(body.assistants[0].content).not.toContain('<<ACTION>>');
    // Second message from Diego
    expect(body.assistants).toHaveLength(2);
    expect(body.assistants[1].content).toContain('pgvector');
    // Action audit
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0].kind).toBe('consult');
    expect(body.actions[0].status).toBe('ok');
  });

  it('manager directive create_project inserts project + team', async () => {
    app = await buildAppWithRunner(
      new Map([
        [
          'chat-',
          'OK, spinning up the project.\n\n<<ACTION>>\n{"kind":"create_project","name":"InvoiceLite","goal":"Minimal CLI invoice generator","repoPath":"C:/tmp/invoice-lite","team":["backend-dev","qa-engineer"]}\n<<END>>',
        ],
      ]),
    );
    const managerId = await getManagerId(app);
    const t = await app.inject({
      method: 'POST',
      url: `/api/agents/${managerId}/threads`,
      payload: {},
    });
    const threadId = (t.json() as { id: string }).id;
    const send = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: 'Please create a project for an invoice CLI.' },
    });
    expect(send.statusCode).toBe(201);
    const body = send.json();
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0].kind).toBe('create_project');
    expect(body.actions[0].status).toBe('ok');
    const result = body.actions[0].result as {
      projectId: string;
      name: string;
      teamSize: number;
    };
    expect(result.projectId).toMatch(/[0-9a-f-]{36}/);
    expect(result.name).toBe('InvoiceLite');
    expect(result.teamSize).toBe(2);

    const projGet = await app.inject({ method: 'GET', url: '/api/projects' });
    const list = projGet.json() as Array<{ id: string; name: string }>;
    expect(list.find((p) => p.id === result.projectId)?.name).toBe('InvoiceLite');

    const teamGet = await app.inject({
      method: 'GET',
      url: `/api/projects/${result.projectId}/team`,
    });
    expect(teamGet.statusCode).toBe(200);
    const team = teamGet.json() as { roles: Array<{ agentId: string; role: string }> };
    expect(team.roles).toHaveLength(2);
    expect(team.roles.map((r) => r.role).sort()).toEqual(['backend-dev', 'qa-engineer']);
  });

  it('manager directive add_member adds a participant; subsequent @mention routes to them', async () => {
    app = await buildAppWithRunner(
      new Map([
        [
          'chat-',
          'Bringing Sven in.\n\n<<ACTION>>\n{"kind":"add_member","agent":"devops"}\n<<END>>',
        ],
      ]),
    );
    const managerId = await getManagerId(app);
    const all = await app.inject({ method: 'GET', url: '/api/agents' });
    const list = all.json() as Array<{ id: string; seedKey: string | null }>;
    const sven = list.find((a) => a.seedKey === 'devops')!;

    const t = await app.inject({
      method: 'POST',
      url: `/api/agents/${managerId}/threads`,
      payload: {},
    });
    const threadId = (t.json() as { id: string }).id;
    const send = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: 'I think we need devops support.' },
    });
    expect(send.statusCode).toBe(201);
    const body = send.json();
    expect(body.actions[0].kind).toBe('add_member');
    expect(body.actions[0].status).toBe('ok');

    const parts = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/participants`,
    });
    const parr = parts.json() as Array<{ agentId: string; seedKey: string }>;
    expect(parr.find((p) => p.agentId === sven.id)).toBeDefined();
  });

  it('compress: collapses message history to first user msg + one summary', async () => {
    app = await buildAppWithRunner(
      new Map([
        ['chat-', 'I think A is the right path.'],
        ['chat-compress-', '- Decision: ship MVP this sprint.\n- Open: pricing tiers.'],
      ]),
    );
    const managerId = await getManagerId(app);
    const t = await app.inject({
      method: 'POST',
      url: `/api/agents/${managerId}/threads`,
      payload: {},
    });
    const threadId = (t.json() as { id: string }).id;
    // 3 user turns × 1 assistant reply each = 6 messages total.
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/messages`,
        payload: { content: `Question ${i}` },
      });
      expect(r.statusCode).toBe(201);
    }
    const before = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/messages`,
    });
    expect((before.json() as unknown[]).length).toBeGreaterThanOrEqual(6);

    const compress = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/compress`,
    });
    expect(compress.statusCode).toBe(200);
    const cbody = compress.json();
    expect(cbody.compressed).toBe(true);

    const after = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/messages`,
    });
    const list = after.json() as Array<{ role: string; content: string }>;
    expect(list).toHaveLength(2); // first user + 1 summary
    expect(list[0].role).toBe('user');
    expect(list[1].role).toBe('assistant');
    expect(list[1].content).toContain('summary');
  });

  it('seed agents are installed and idempotent across reruns', async () => {
    const before = seedAgents();
    // After a re-run with no source-prompt changes, installed should be 0.
    const after = seedAgents();
    expect(after.installed).toBe(0);
    expect(before.installed).toBeGreaterThanOrEqual(0); // already installed earlier
  });

  it('per-thread mutex: a concurrent send to the same thread gets 409', async () => {
    const slowApp = Fastify({ logger: false });
    await slowApp.register(agentRoutes);
    await slowApp.register(projectRoutes);
    await slowApp.register(createPlansRouter({}));
    await slowApp.register(createChatRouter({ runner: makeSlowRunner(150, 'ok') }));
    await slowApp.ready();
    try {
      const managerId = await getManagerId(slowApp);
      const t = await slowApp.inject({
        method: 'POST',
        url: `/api/agents/${managerId}/threads`,
        payload: {},
      });
      const threadId = (t.json() as { id: string }).id;

      // Fire two sends at once. The first acquires the lock and holds it for the
      // slow runner's duration; the second must bounce with 409.
      const [a, b] = await Promise.all([
        slowApp.inject({
          method: 'POST',
          url: `/api/threads/${threadId}/messages`,
          payload: { content: 'first' },
        }),
        slowApp.inject({
          method: 'POST',
          url: `/api/threads/${threadId}/messages`,
          payload: { content: 'second' },
        }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes).toContain(409); // one bounced
      expect(codes.some((c) => c === 201)).toBe(true); // the other completed

      // Lock released after the turn — a fresh sequential send succeeds (not 409).
      const c = await slowApp.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/messages`,
        payload: { content: 'third' },
      });
      expect(c.statusCode).toBe(201);
    } finally {
      await slowApp.close();
    }
  });

  it('directiveSchema accepts generate_plan with and without projectId', () => {
    expect(directiveSchema.parse({ kind: 'generate_plan' })).toEqual({ kind: 'generate_plan' });
    expect(directiveSchema.parse({ kind: 'generate_plan', projectId: 'x' })).toEqual({
      kind: 'generate_plan',
      projectId: 'x',
    });
  });

  it('manager directive generate_plan without a prior create_project fails synchronously', async () => {
    app = await buildAppWithRunner(
      new Map([
        ['chat-', 'Generating a plan now.\n\n<<ACTION>>\n{"kind":"generate_plan"}\n<<END>>'],
      ]),
    );
    const managerId = await getManagerId(app);
    const t = await app.inject({
      method: 'POST',
      url: `/api/agents/${managerId}/threads`,
      payload: {},
    });
    const threadId = (t.json() as { id: string }).id;
    const send = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: 'Generate a plan please.' },
    });
    expect(send.statusCode).toBe(201);
    const body = send.json();
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0].kind).toBe('generate_plan');
    // No project in the thread → handler throws no_project synchronously, so
    // the row is persisted as failed (NOT pending).
    expect(body.actions[0].status).toBe('failed');
    const result = body.actions[0].result as { error?: string } | null;
    expect(result?.error).toContain('no_project');
  });

  // --- Branch 1: generate_plan persists a 'pending' chat_actions row synchronously ---
  it('generate_plan persists a pending chat_actions row synchronously before the async job', async () => {
    // A real project + team exist → eager validation passes → handler returns
    // immediately with status 'pending' (the bg loopback job runs later). The
    // projectId is carried IN the directive JSON (the handler resolves it from
    // the directive or a prior create_project action, not from message prose).
    const projectId = seedProjectWithTeam('PendingProj');
    app = await buildAppWithRunner(
      new Map([
        [
          'chat-',
          directiveReply('Planning now.', `{"kind":"generate_plan","projectId":"${projectId}"}`),
        ],
      ]),
    );
    // Point the bg loopback at a dead port so it can never race to patch the
    // row before our synchronous read (and never hits a real server on 4400).
    const savedPort = env.WISP_PORT;
    const savedHost = env.WISP_HOST;
    env.WISP_HOST = '127.0.0.1';
    env.WISP_PORT = 1;
    try {
      const threadId = await newManagerThread(app);
      const send = await app.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/messages`,
        payload: { content: 'Generate a plan please.' },
      });
      expect(send.statusCode).toBe(201);

      const body = send.json();
      expect(body.actions).toHaveLength(1);
      expect(body.actions[0].kind).toBe('generate_plan');
      // The synchronous response carries the 'pending' status — the directive
      // launched a bg job but did NOT await it.
      expect(body.actions[0].status).toBe('pending');
      const syncResult = body.actions[0].result as { planGenStarted?: boolean } | null;
      expect(syncResult?.planGenStarted).toBe(true);

      // The persisted row is also 'pending' right after the send. We read it
      // synchronously (the bg job is deferred behind setImmediate + a real
      // loopback fetch, so it cannot have patched the row this early).
      const row = readAction(threadId, 'generate_plan');
      expect(row).toBeDefined();
      expect(row!.status).toBe('pending');
      expect(row!.id).toBe(body.actions[0].id);

      // Let the deferred bg job settle (to 'failed' against the dead port) so
      // it doesn't leak into a later test's DB reads.
      await waitForActionStatus(threadId, 'generate_plan', 'failed');
    } finally {
      env.WISP_PORT = savedPort;
      env.WISP_HOST = savedHost;
    }
  });

  // --- Branch 2 (a): generate_plan ERROR path — plan-gen over loopback cannot
  // succeed (no live server is listening on env.WISP_PORT in app.inject mode),
  // so the bg fetch throws ECONNREFUSED → the row is patched to 'failed'. ---
  it('generate_plan bg job patches the row to failed when plan-gen loopback fails', async () => {
    const projectId = seedProjectWithTeam('FailProj');
    app = await buildAppWithRunner(
      new Map([
        [
          'chat-',
          directiveReply('Planning now.', `{"kind":"generate_plan","projectId":"${projectId}"}`),
        ],
      ]),
    );
    // Point the bg job's loopback at a port with nothing listening so the
    // fetch deterministically fails (ECONNREFUSED) rather than hanging.
    const savedPort = env.WISP_PORT;
    const savedHost = env.WISP_HOST;
    env.WISP_HOST = '127.0.0.1';
    env.WISP_PORT = 1; // privileged/unused — connect refused immediately
    try {
      const threadId = await newManagerThread(app);
      const send = await app.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/messages`,
        payload: { content: 'Generate a plan please.' },
      });
      expect(send.statusCode).toBe(201);
      const actionId = (send.json().actions[0] as { id: string }).id;

      // Wait for the deferred bg job to patch the row to 'failed'.
      const finalStatus = await waitForActionStatus(threadId, 'generate_plan', 'failed');
      expect(finalStatus).toBe('failed');
      const row = readAction(threadId, 'generate_plan')!;
      expect(row.id).toBe(actionId);
      const result = row.result_json ? (JSON.parse(row.result_json) as { error?: string }) : null;
      expect(typeof result?.error).toBe('string');
      expect(result!.error!.length).toBeGreaterThan(0);
    } finally {
      env.WISP_PORT = savedPort;
      env.WISP_HOST = savedHost;
    }
  });

  // --- Branch 2 (b): the lock-failure DELETE path. The bg job's loopback hits a
  // live test server whose /plan returns a real draft plan id but whose /lock
  // returns non-ok → the handler must (1) mark the row 'failed' AND (2) DELETE
  // the orphaned draft plan row (DELETE FROM plans WHERE id=? AND status='draft').
  it('generate_plan deletes the orphaned draft + marks the row failed when lock fails', async () => {
    const projectId = seedProjectWithTeam('LockFailProj');
    app = await buildAppWithRunner(
      new Map([
        [
          'chat-',
          directiveReply('Planning now.', `{"kind":"generate_plan","projectId":"${projectId}"}`),
        ],
      ]),
    );

    // A real draft plan row the bg job's /plan response will point at. After a
    // failed lock, the handler must delete exactly this row.
    const draftPlanId = randomUUID();
    sqlite
      .prepare(`INSERT INTO plans (id, project_id, dag_json, status) VALUES (?, ?, ?, 'draft')`)
      .run(draftPlanId, projectId, JSON.stringify({ goal: 'x', nodes: [], edges: [] }));

    // A tiny live loopback server that mimics the two endpoints the bg job
    // calls: /plan returns the real draft id (ok), /lock returns 409 (fail).
    const loopback = Fastify({ logger: false });
    loopback.post('/api/projects/:id/plan', async (_req, reply) => {
      reply.code(201);
      return { id: draftPlanId };
    });
    loopback.post('/api/plans/:planId/lock', async (_req, reply) => {
      reply.code(409);
      return { error: 'invalid-transition' };
    });
    await loopback.listen({ host: '127.0.0.1', port: 0 });
    const addr = loopback.server.address();
    const livePort = typeof addr === 'object' && addr ? addr.port : 0;
    expect(livePort).toBeGreaterThan(0);

    const savedPort = env.WISP_PORT;
    const savedHost = env.WISP_HOST;
    env.WISP_HOST = '127.0.0.1';
    env.WISP_PORT = livePort;
    try {
      const threadId = await newManagerThread(app);
      const send = await app.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/messages`,
        payload: { content: `Generate a plan for ${projectId}` },
      });
      expect(send.statusCode).toBe(201);

      // bg job: /plan ok → /lock fail → DELETE draft + patch row to failed.
      const finalStatus = await waitForActionStatus(threadId, 'generate_plan', 'failed');
      expect(finalStatus).toBe('failed');

      // The orphaned draft plan row was deleted.
      const stillThere = db.select().from(plans).where(eq(plans.id, draftPlanId)).get();
      expect(stillThere).toBeUndefined();

      // The failure reason is the lock error surfaced by the bg job.
      const row = readAction(threadId, 'generate_plan')!;
      const result = row.result_json ? (JSON.parse(row.result_json) as { error?: string }) : null;
      expect(result?.error).toContain('invalid-transition');
    } finally {
      env.WISP_PORT = savedPort;
      env.WISP_HOST = savedHost;
      await loopback.close();
    }
  });

  // --- Branch 3: start_run soft-fail + no-project paths ---
  it('start_run returns no_plan_yet (status ok) when the project has no plan', async () => {
    // Seed the project FIRST so the scripted directive can carry its real id.
    const projectId = seedProjectWithTeam('NoPlanProj');
    app = await buildAppWithRunner(
      new Map([
        [
          'chat-',
          directiveReply('Starting the run.', `{"kind":"start_run","projectId":"${projectId}"}`),
        ],
      ]),
    );
    const threadId = await newManagerThread(app);
    const send = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: 'Start the run.' },
    });
    expect(send.statusCode).toBe(201);
    const body = send.json();
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0].kind).toBe('start_run');
    // Project exists but has no plan → soft-fail (handler returns a result, so
    // the audit status is 'ok' even though the run did not start).
    expect(body.actions[0].status).toBe('ok');
    const result = body.actions[0].result as {
      runStarted?: boolean;
      reason?: string;
      projectId?: string;
    };
    expect(result.runStarted).toBe(false);
    expect(result.reason).toBe('no_plan_yet');
    expect(result.projectId).toBe(projectId);
  });

  it('start_run with no project to run fails (no projectId + no create_project)', async () => {
    app = await buildAppWithRunner(
      new Map([['chat-', directiveReply('Starting the run.', '{"kind":"start_run"}')]]),
    );
    const threadId = await newManagerThread(app);
    const send = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: 'Start the run.' },
    });
    expect(send.statusCode).toBe(201);
    const body = send.json();
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0].kind).toBe('start_run');
    // No projectId given AND no prior create_project in the thread → throws.
    expect(body.actions[0].status).toBe('failed');
    const result = body.actions[0].result as { error?: string } | null;
    expect(result?.error).toContain('no_project_to_run');
  });

  // --- Branch 4: MAX_DIRECTIVES_PER_TURN cap (=4) ---
  it('executes at most MAX_DIRECTIVES_PER_TURN (4) directives when the manager emits more', async () => {
    // 6 add_member directives in one reply; only the first 4 should execute.
    // Pick 6 distinct seed members so each would add a real participant.
    const memberSeeds = [
      'frontend-dev',
      'backend-dev',
      'qa-engineer',
      'devops',
      'designer',
      'ml-engineer',
    ];
    const blocks = memberSeeds
      .map((seed) => `<<ACTION>>\n{"kind":"add_member","agent":"${seed}"}\n<<END>>`)
      .join('\n');
    app = await buildAppWithRunner(new Map([['chat-', `Adding the whole crew.\n\n${blocks}`]]));

    const threadId = await newManagerThread(app);
    const send = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: 'Add everyone please.' },
    });
    expect(send.statusCode).toBe(201);
    const body = send.json();
    // Cap is 4 — even though 6 directives were emitted.
    expect(body.actions).toHaveLength(4);
    expect(body.actions.every((a: { kind: string }) => a.kind === 'add_member')).toBe(true);

    // And the audit table persisted exactly 4 rows for this thread.
    const count = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS c FROM chat_actions WHERE thread_id = ? AND kind = 'add_member'`,
        )
        .get(threadId) as { c: number }
    ).c;
    expect(count).toBe(4);
  });
});

/**
 * Poll the chat_actions row until it reaches `want` (or times out). The
 * generate_plan bg job is fire-and-forget (setImmediate + a real loopback
 * fetch), so tests must wait for the async patch instead of asserting inline.
 */
async function waitForActionStatus(
  threadId: string,
  kind: string,
  want: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  // Read via the same module-level helper hoisted above.
  for (;;) {
    const rows = sqlite
      .prepare(
        `SELECT status FROM chat_actions WHERE thread_id = ? AND kind = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(threadId, kind) as { status: string } | undefined;
    if (rows && rows.status === want) return rows.status;
    if (Date.now() > deadline) return rows?.status ?? '(no row)';
    await new Promise((r) => setTimeout(r, 25));
  }
}
