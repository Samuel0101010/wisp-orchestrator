import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { HarnessEvent } from '@wisp/schemas';
import { runClaude } from '../subprocess.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_BIN = resolve(__dirname, '../../tests/fixtures/mock-claude.mjs');

async function collect(iter: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('subprocess max-turns detection', () => {
  it('emits task.max-turns-exhausted when stderr matches the pattern', async () => {
    const events = await collect(
      runClaude({
        cwd: tmpdir(),
        prompt: 'hi',
        allowedTools: [],
        maxTurns: 4,
        taskId: 't1',
        __mockBin: MOCK_BIN,
        __mockEnv: { MOCK_MODE: 'max-turns-stderr' },
      }),
    );
    const maxEv = events.find((e) => e.type === 'task.max-turns-exhausted');
    expect(maxEv).toBeDefined();
    const failed = events.find((e) => e.type === 'task.failed');
    expect(failed).toBeDefined();
    if (failed?.type === 'task.failed') {
      expect(failed.payload.error).toBe('max-turns-exhausted');
    }
  });

  it('emits task.max-turns-exhausted when result frame turns >= maxTurns', async () => {
    const events = await collect(
      runClaude({
        cwd: tmpdir(),
        prompt: 'hi',
        allowedTools: [],
        maxTurns: 4,
        taskId: 't2',
        __mockBin: MOCK_BIN,
        __mockEnv: { MOCK_MODE: 'max-turns-result' },
      }),
    );
    const maxEv = events.find((e) => e.type === 'task.max-turns-exhausted');
    expect(maxEv).toBeDefined();
    if (maxEv?.type === 'task.max-turns-exhausted') {
      expect(maxEv.payload.turnsUsed).toBe(4);
      expect(maxEv.payload.maxTurns).toBe(4);
    }
  });

  it('does NOT emit task.max-turns-exhausted for unrelated stderr', async () => {
    const events = await collect(
      runClaude({
        cwd: tmpdir(),
        prompt: 'hi',
        allowedTools: [],
        maxTurns: 4,
        taskId: 't3',
        __mockBin: MOCK_BIN,
        __mockEnv: { MOCK_MODE: 'fail-other' },
      }),
    );
    expect(events.find((e) => e.type === 'task.max-turns-exhausted')).toBeUndefined();
    const failed = events.find((e) => e.type === 'task.failed');
    expect(failed).toBeDefined();
    if (failed?.type === 'task.failed') {
      expect(failed.payload.error).toContain('ENOENT');
    }
  });
});
