import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { HarnessEvent } from '@agent-harness/schemas';
import { runClaude, ClaudeSubprocess } from '../subprocess.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_BIN = resolve(__dirname, '../../tests/fixtures/mock-claude.mjs');

async function collect(iter: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('runClaude (mock)', () => {
  it('emits text-delta, tool-use, usage, then task.completed on clean exit', async () => {
    const events = await collect(
      runClaude({
        cwd: tmpdir(),
        prompt: 'hello',
        allowedTools: ['Read'],
        maxTurns: 1,
        taskId: 't-1',
        __mockBin: MOCK_BIN,
        __mockEnv: { MOCK_MODE: 'ok' },
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain('task.text-delta');
    expect(types).toContain('task.tool-use');
    expect(types).toContain('task.usage');
    expect(types[types.length - 1]).toBe('task.completed');

    const completed = events.find((e) => e.type === 'task.completed');
    if (completed?.type === 'task.completed') {
      expect(completed.payload.outcome).toBe('pass');
      expect(completed.payload.exitCode).toBe(0);
      expect(completed.payload.taskId).toBe('t-1');
    }

    const usage = events.find((e) => e.type === 'task.usage');
    if (usage?.type === 'task.usage') {
      expect(usage.payload.tokensIn).toBe(12);
      expect(usage.payload.tokensOut).toBe(7);
      expect(usage.payload.turns).toBe(1);
    }
  });

  it('emits task.failed with stderr tail when subprocess exits non-zero', async () => {
    const events = await collect(
      runClaude({
        cwd: tmpdir(),
        prompt: 'x',
        allowedTools: [],
        maxTurns: 1,
        taskId: 't-2',
        __mockBin: MOCK_BIN,
        __mockEnv: { MOCK_MODE: 'fail' },
      }),
    );

    const last = events[events.length - 1];
    expect(last?.type).toBe('task.failed');
    if (last?.type === 'task.failed') {
      expect(last.payload.error).toContain('boom');
      expect(last.payload.taskId).toBe('t-2');
    }
  });

  it('emits rate-limit.hit then task.failed(rate-limited) when stderr contains a marker', async () => {
    const events = await collect(
      runClaude({
        cwd: tmpdir(),
        prompt: 'x',
        allowedTools: [],
        maxTurns: 1,
        taskId: 't-3',
        runId: 'r-3',
        __mockBin: MOCK_BIN,
        __mockEnv: { MOCK_MODE: 'rate-limit' },
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain('rate-limit.hit');
    expect(types[types.length - 1]).toBe('task.failed');

    const hit = events.find((e) => e.type === 'rate-limit.hit');
    if (hit?.type === 'rate-limit.hit') {
      expect(hit.payload.taskId).toBe('t-3');
      expect(hit.payload.runId).toBe('r-3');
      expect(hit.payload.source).toBe('stdout-marker');
    }

    const failed = events.find((e) => e.type === 'task.failed');
    if (failed?.type === 'task.failed') {
      expect(failed.payload.error).toBe('rate-limited');
    }
  });

  it('skips garbled / unknown lines without crashing and still completes', async () => {
    const events = await collect(
      runClaude({
        cwd: tmpdir(),
        prompt: 'x',
        allowedTools: [],
        maxTurns: 1,
        taskId: 't-4',
        __mockBin: MOCK_BIN,
        __mockEnv: { MOCK_MODE: 'garbled' },
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain('task.text-delta');
    expect(types[types.length - 1]).toBe('task.completed');
  });
});

describe('ClaudeSubprocess class', () => {
  it('exposes pid after start and supports kill()', async () => {
    const sp = new ClaudeSubprocess({
      cwd: tmpdir(),
      prompt: 'x',
      allowedTools: [],
      maxTurns: 1,
      taskId: 't-class',
      __mockBin: MOCK_BIN,
      __mockEnv: { MOCK_MODE: 'ok' },
    });
    const iter = sp.start();
    // Pull at least one event to ensure spawn has happened.
    const it = iter[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(typeof sp.pid).toBe('number');
    // Drain.
    while (!(await it.next()).done) {
      // consume
    }
    // After exit, kill is a no-op.
    await sp.kill();
  });
});
