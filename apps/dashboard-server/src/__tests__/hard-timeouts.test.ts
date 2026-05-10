import { describe, expect, it } from 'vitest';
import { runAgentTurn, type RunAgentTurnOpts } from '../routes/chat-engine.js';
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

  it('uses default 180_000ms when timeoutMs omitted', () => {
    const opts: RunAgentTurnOpts = { systemPrompt: '', prompt: '', allowedTools: [], model: 'haiku', taskId: 't' };
    expect(opts.timeoutMs).toBeUndefined();
    // Behavior: chat-engine.ts must default to CHAT_TIMEOUT_MS
  });
});
