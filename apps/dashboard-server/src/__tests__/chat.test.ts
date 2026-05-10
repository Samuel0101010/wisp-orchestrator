import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { HarnessEvent } from '@agent-harness/schemas';
import type { RunClaudeOpts } from '@agent-harness/orchestrator';
import { agentRoutes } from '../routes/agents.js';
import { createChatRouter } from '../routes/chat.js';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';

function makeMockRunner(parts: { text?: string; fail?: string }) {
  return async function* mockRunner(opts: RunClaudeOpts): AsyncGenerator<HarnessEvent> {
    const text = parts.text ?? '';
    if (text) {
      yield { type: 'task.text-delta', payload: { taskId: opts.taskId, text } };
    }
    yield {
      type: 'task.usage',
      payload: { taskId: opts.taskId, tokensIn: 30, tokensOut: 20, turns: 1 },
    };
    if (parts.fail) {
      yield {
        type: 'task.failed',
        payload: { taskId: opts.taskId, error: parts.fail },
      };
    } else {
      yield {
        type: 'task.completed',
        payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
      };
    }
  };
}

async function buildTestApp(parts: Parameters<typeof makeMockRunner>[0]): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(agentRoutes);
  await app.register(createChatRouter({ runner: makeMockRunner(parts) }));
  await app.ready();
  return app;
}

describe('chat threads + messages', () => {
  let app: FastifyInstance;
  let agentId: string;

  beforeAll(async () => {
    runMigrations();
    app = await buildTestApp({ text: 'Hello from the agent.' });
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'chat-agent',
        model: 'sonnet',
        systemPrompt: 'You answer concisely with technical clarity.',
        allowedTools: [],
      },
    });
    agentId = created.json().id;
  });

  afterAll(async () => {
    await app.close();
    sqlite.close();
  });

  it('creates a thread and lists it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/threads`,
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const thread = created.json();
    expect(thread.agentId).toBe(agentId);
    expect(thread.projectId).toBeNull();

    const list = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/threads` });
    expect(list.statusCode).toBe(200);
    const items = list.json();
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(thread.id);
  });

  it('sends a message and persists user + assistant rows', async () => {
    const t = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/threads`,
      payload: {},
    });
    const threadId = t.json().id;

    const send = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: 'How do I avoid race conditions?' },
    });
    expect(send.statusCode).toBe(201);
    const body = send.json();
    expect(body.user.role).toBe('user');
    expect(body.user.content).toBe('How do I avoid race conditions?');
    expect(Array.isArray(body.assistants)).toBe(true);
    expect(body.assistants[0].role).toBe('assistant');
    expect(body.assistants[0].content).toBe('Hello from the agent.');
    expect(body.assistants[0].tokensIn).toBe(30);
    expect(body.assistants[0].tokensOut).toBe(20);
    expect(body.assistants[0].errorReason).toBeNull();
    expect(body.actions).toEqual([]);

    const messages = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/messages`,
    });
    const list = messages.json();
    expect(list).toHaveLength(2);
    expect(list[0].role).toBe('user');
    expect(list[1].role).toBe('assistant');
  });

  it('auto-titles the thread on first message', async () => {
    const t = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/threads`,
      payload: {},
    });
    const threadId = t.json().id as string;

    await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: 'What is your favourite refactoring smell?' },
    });

    const detail = await app.inject({ method: 'GET', url: `/api/threads/${threadId}` });
    const json = detail.json();
    expect(json.thread.title).toBe('What is your favourite refactoring smell?');
  });

  it('returns 502 when the runner fails', async () => {
    const failApp = await buildTestApp({ fail: 'subprocess-crashed' });
    const a = await failApp.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'fail-agent',
        model: 'haiku',
        systemPrompt: 'Failing agent, sufficiently long system prompt.',
        allowedTools: [],
      },
    });
    const failAgentId = a.json().id as string;
    const t = await failApp.inject({
      method: 'POST',
      url: `/api/agents/${failAgentId}/threads`,
      payload: {},
    });
    const threadId = t.json().id;
    const send = await failApp.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: 'will the agent error?' },
    });
    expect(send.statusCode).toBe(502);
    const body = send.json();
    expect(body.assistants[0].errorReason).toBe('subprocess-crashed');
    await failApp.close();
  });

  it('DELETE thread cascades messages', async () => {
    const t = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/threads`,
      payload: {},
    });
    const threadId = t.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: 'msg before delete' },
    });
    const del = await app.inject({ method: 'DELETE', url: `/api/threads/${threadId}` });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/messages`,
    });
    expect(after.statusCode).toBe(404);
  });
});
