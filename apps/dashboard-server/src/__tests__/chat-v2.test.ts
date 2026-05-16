import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { HarnessEvent } from '@wisp/schemas';
import type { RunClaudeOpts } from '@wisp/orchestrator';
import { agentRoutes } from '../routes/agents.js';
import { createChatRouter } from '../routes/chat.js';
import { projectRoutes } from '../routes/projects.js';
import { createPlansRouter } from '../routes/plans.js';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';
import { seedAgents } from '../db/agents-seed.js';

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
});
