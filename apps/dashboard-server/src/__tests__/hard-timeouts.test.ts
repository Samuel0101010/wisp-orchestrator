import { describe, expect, it, vi } from 'vitest';
import { runAgentTurn } from '../routes/chat-engine.js';
import type { HarnessEvent } from '@agent-harness/schemas';
import type { RunClaudeOpts } from '@agent-harness/orchestrator';

describe('runAgentTurn timeout', () => {
  it('returns failed="timeout" when runner exceeds timeoutMs', async () => {
    async function* hangingRunner(opts: RunClaudeOpts): AsyncGenerator<HarnessEvent> {
      // Simulate a runner that never yields completion until aborted
      await new Promise((r, rej) => {
        opts.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      });
      yield { type: 'task.completed', payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 } };
    }
    const result = await runAgentTurn({
      systemPrompt: 'x', prompt: 'x', allowedTools: [], model: 'haiku',
      taskId: 'tt', runner: hangingRunner, timeoutMs: 100,
    });
    expect(result.failed).toBe('timeout');
    expect(result.text).toBe('');
  });

  it('defaults to 180_000ms when timeoutMs is omitted', async () => {
    async function* fastRunner(opts: RunClaudeOpts): AsyncGenerator<HarnessEvent> {
      yield { type: 'task.usage', payload: { taskId: opts.taskId, tokensIn: 0, tokensOut: 0, turns: 1 } };
      yield { type: 'task.completed', payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 } };
    }
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      await runAgentTurn({
        systemPrompt: '', prompt: '', allowedTools: [], model: 'haiku',
        taskId: 't', runner: fastRunner,
      });
      const callsWith180k = spy.mock.calls.filter((c) => c[1] === 180_000);
      expect(callsWith180k.length).toBeGreaterThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });
});
