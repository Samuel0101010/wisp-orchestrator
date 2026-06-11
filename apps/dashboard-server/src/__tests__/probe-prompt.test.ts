import './setup.js';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { HarnessEvent } from '@wisp/schemas';
import type { RunClaudeOpts } from '@wisp/orchestrator';
import { probePromptRoutes } from '../routes/probe-prompt.js';
import { _setAuthProbeImplForTests, setLastAuthProbe } from '../auth-status.js';

/**
 * Async generator factory mocking the runClaude contract: emits a few
 * text-delta events, a usage event, and an exit. Keeps tests deterministic
 * without spawning the real `claude` CLI.
 */
function makeMockRunner(parts: {
  text?: string;
  tokensIn?: number;
  tokensOut?: number;
  turns?: number;
  fail?: string;
}) {
  return async function* mockRunner(opts: RunClaudeOpts): AsyncGenerator<HarnessEvent> {
    if (parts.text) {
      // Yield text in two chunks to exercise the response-accumulator.
      const half = Math.ceil(parts.text.length / 2);
      yield {
        type: 'task.text-delta',
        payload: { taskId: opts.taskId, text: parts.text.slice(0, half) },
      };
      yield {
        type: 'task.text-delta',
        payload: { taskId: opts.taskId, text: parts.text.slice(half) },
      };
    }
    yield {
      type: 'task.usage',
      payload: {
        taskId: opts.taskId,
        tokensIn: parts.tokensIn ?? 100,
        tokensOut: parts.tokensOut ?? 50,
        turns: parts.turns ?? 1,
      },
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
  await app.register(probePromptRoutes({ runner: makeMockRunner(parts) }));
  await app.ready();
  return app;
}

describe('POST /api/probe-prompt', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    if (app) await app.close();
  });

  afterEach(() => {
    setLastAuthProbe(null);
    _setAuthProbeImplForTests();
  });

  it('returns response, tokens, and elapsed on the happy path', async () => {
    app = await buildTestApp({ text: 'Hello, world!', tokensIn: 42, tokensOut: 17, turns: 1 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/probe-prompt',
      payload: {
        systemPrompt: 'You are a helper.',
        sampleGoal: 'Say hi.',
        model: 'haiku',
        allowedTools: ['Read'],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      response: string;
      tokensIn: number;
      tokensOut: number;
      turns: number;
      elapsedMs: number;
    };
    expect(body.response).toBe('Hello, world!');
    expect(body.tokensIn).toBe(42);
    expect(body.tokensOut).toBe(17);
    expect(body.turns).toBe(1);
    expect(body.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('returns 400 on a missing/invalid body', async () => {
    app = await buildTestApp({ text: '' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/probe-prompt',
      payload: { systemPrompt: '', sampleGoal: 'x', model: 'opus' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBe('invalid_body');
  });

  it('returns 400 on unsupported model', async () => {
    app = await buildTestApp({ text: '' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/probe-prompt',
      payload: {
        systemPrompt: 'x',
        sampleGoal: 'y',
        model: 'gpt-4',
        allowedTools: [],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 when subscription auth probe last failed', async () => {
    if (process.env.WISP_MOCK_CLI === '1') {
      // Auth gate is bypassed in mock-cli mode; mirrors the runs-route
      // auth-block test's skip behavior.
      return;
    }
    setLastAuthProbe({ ok: false, error: 'expired', hint: 'run claude login' });
    // The gate re-probes on a cached failure (self-heal); pin the re-probe to
    // the same failure so the test stays deterministic and CLI-free.
    _setAuthProbeImplForTests(async () => ({
      ok: false,
      error: 'expired',
      hint: 'run claude login',
    }));
    app = await buildTestApp({ text: 'should never run' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/probe-prompt',
      payload: {
        systemPrompt: 'You are a helper.',
        sampleGoal: 'Say hi.',
        model: 'haiku',
        allowedTools: [],
      },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: string; hint: string };
    expect(body.error).toBe('auth-failed');
    expect(body.hint).toBe('run claude login');
  });

  it('reports a probe failure as 502 with partial response and tokens', async () => {
    app = await buildTestApp({ text: 'partial', fail: 'rate-limited', tokensIn: 5, tokensOut: 0 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/probe-prompt',
      payload: {
        systemPrompt: 'You are a helper.',
        sampleGoal: 'Say hi.',
        model: 'haiku',
        allowedTools: [],
      },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json() as {
      error: string;
      details: string;
      partial: string;
      tokensIn: number;
    };
    expect(body.error).toBe('probe_failed');
    expect(body.details).toBe('rate-limited');
    expect(body.partial).toBe('partial');
    expect(body.tokensIn).toBe(5);
  });
});
