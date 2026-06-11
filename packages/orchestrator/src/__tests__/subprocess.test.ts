import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { HarnessEvent } from '@wisp/schemas';
import {
  runClaude,
  ClaudeSubprocess,
  buildArgs,
  extractAssistantTurnUsage,
} from '../subprocess.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_BIN = resolve(__dirname, '../../tests/fixtures/mock-claude.mjs');

async function collect(iter: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('runClaude (mock)', () => {
  it('captures session_id from a leading frame and emits task.session-id exactly once', async () => {
    const events = await collect(
      runClaude({
        cwd: tmpdir(),
        prompt: 'hi',
        allowedTools: [],
        maxTurns: 1,
        taskId: 't-sess',
        __mockBin: MOCK_BIN,
        __mockEnv: { MOCK_MODE: 'session-id' },
      }),
    );
    const sessionEvents = events.filter((e) => e.type === 'task.session-id');
    expect(sessionEvents).toHaveLength(1);
    if (sessionEvents[0]?.type === 'task.session-id') {
      expect(sessionEvents[0].payload.taskId).toBe('t-sess');
      expect(sessionEvents[0].payload.sessionId).toBe('sess-abc-123');
    }
    // The session-id event must come BEFORE task.completed so the walker can
    // persist it before any cold-resume reasoning kicks in.
    const sessionIdx = events.findIndex((e) => e.type === 'task.session-id');
    const completedIdx = events.findIndex((e) => e.type === 'task.completed');
    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThan(sessionIdx);
  });

  it('parses assistant-frame content[] into per-item text-delta + tool-use events', async () => {
    // Modern `claude -p --output-format stream-json` wraps text and tool calls
    // inside a single `assistant` frame whose `message.content` is an array of
    // `{type:'text'|'tool_use', ...}` items. Without this case, the dashboard
    // text-delta + tool-use streams stay empty during real runs.
    const events = await collect(
      runClaude({
        cwd: tmpdir(),
        prompt: 'go',
        allowedTools: ['Read'],
        maxTurns: 1,
        taskId: 't-asst',
        __mockBin: MOCK_BIN,
        __mockEnv: { MOCK_MODE: 'assistant-frame' },
      }),
    );

    const textDeltas = events.filter((e) => e.type === 'task.text-delta');
    const toolUses = events.filter((e) => e.type === 'task.tool-use');
    // Two text items + one tool_use across two assistant frames; the leading
    // `thinking`-only frame must produce no events (private reasoning).
    expect(textDeltas).toHaveLength(2);
    expect(toolUses).toHaveLength(1);
    if (textDeltas[0]?.type === 'task.text-delta')
      expect(textDeltas[0].payload.text).toBe('thinking out loud ');
    if (textDeltas[1]?.type === 'task.text-delta')
      expect(textDeltas[1].payload.text).toBe('and a follow-up');
    if (toolUses[0]?.type === 'task.tool-use') {
      expect(toolUses[0].payload.tool).toBe('Read');
      expect(toolUses[0].payload.input).toEqual({ path: '/tmp/x' });
    }
    // Ordering inside the frame is preserved: text → tool_use → text.
    const order = events
      .filter((e) => e.type === 'task.text-delta' || e.type === 'task.tool-use')
      .map((e) => e.type);
    expect(order).toEqual(['task.text-delta', 'task.tool-use', 'task.text-delta']);
  });

  it('streams LIVE task.usage off each assistant frame without ever exceeding the result frame', async () => {
    const events = await collect(
      runClaude({
        cwd: tmpdir(),
        prompt: 'go',
        allowedTools: [],
        maxTurns: 5,
        taskId: 't-live',
        __mockBin: MOCK_BIN,
        __mockEnv: { MOCK_MODE: 'assistant-usage' },
      }),
    );
    const usage = events
      .filter((e) => e.type === 'task.usage')
      .map((e) => (e.type === 'task.usage' ? e.payload : null))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    // Two interim (assistant-frame) updates + the authoritative result frame.
    expect(usage.length).toBe(3);
    // Frame 1 snapshot: 100 + 10 cache-create in, 20 out, 1 turn.
    expect(usage[0]).toMatchObject({ tokensIn: 110, tokensOut: 20, turns: 1 });
    // Frame 2 snapshot via Math.max (NOT a sum): max(110,200)=200 in,
    // max(20,30)=30 out, 2 turns. The live value tracks the growing context and
    // converges to the result frame — it must never exceed it.
    expect(usage[1]).toMatchObject({ tokensIn: 200, tokensOut: 30, turns: 2 });
    // The authoritative result frame: identical, so Math.max in the consumer
    // never locks in an inflated live total.
    expect(usage[2]).toMatchObject({ tokensIn: 200, tokensOut: 30, turns: 2 });
    // Regression guard: no live update may exceed the result-frame total.
    const result = usage[2]!;
    for (const u of usage) {
      expect(u.tokensIn).toBeLessThanOrEqual(result.tokensIn);
      expect(u.tokensOut).toBeLessThanOrEqual(result.tokensOut);
    }
  });

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

  it('does NOT trigger rate-limit detection when model prose merely mentions "rate limit"', async () => {
    // Regression for the false-positive that paused a run mid-task when the
    // agent narrated "…so we don't hit a rate limit boundary." The detector
    // must only fire on stderr or on structured error frames, not on
    // assistant text-delta content streamed over stdout.
    const events = await collect(
      runClaude({
        cwd: tmpdir(),
        prompt: 'x',
        allowedTools: [],
        maxTurns: 1,
        taskId: 't-prose',
        runId: 'r-prose',
        __mockBin: MOCK_BIN,
        __mockEnv: { MOCK_MODE: 'prose-mentions-rate-limit' },
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).not.toContain('rate-limit.hit');
    expect(types[types.length - 1]).toBe('task.completed');
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

  it('parses task.usage from result frame, summing input + cache_creation tokens', async () => {
    const events = await collect(
      runClaude({
        cwd: tmpdir(),
        prompt: 'hi',
        allowedTools: [],
        maxTurns: 1,
        taskId: 't-cache',
        __mockBin: MOCK_BIN,
        __mockEnv: { MOCK_MODE: 'usage-with-cache' },
      }),
    );
    const usage = events.find((e) => e.type === 'task.usage');
    expect(usage).toBeDefined();
    if (usage?.type === 'task.usage') {
      expect(usage.payload.tokensIn).toBe(6 + 35447);
      expect(usage.payload.tokensOut).toBe(8);
      expect(usage.payload.turns).toBe(3);
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

describe('buildArgs — mcpConfigPath', () => {
  it('omits --mcp-config flags when no mcpConfigPath set', () => {
    const args = buildArgs({
      cwd: '/x',
      prompt: 'p',
      allowedTools: [],
      maxTurns: 5,
      taskId: 't',
    });
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('always passes --permission-mode bypassPermissions (subprocess is headless)', () => {
    // Without this flag, the in-subprocess `claude -p` runs in default
    // permission mode and silently rejects Write/Bash calls because there is
    // no UI to accept the approval prompt. Verification then fails because no
    // file ever lands on disk.
    const args = buildArgs({
      cwd: '/x',
      prompt: 'p',
      allowedTools: [],
      maxTurns: 1,
      taskId: 't',
    });
    const idx = args.indexOf('--permission-mode');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('bypassPermissions');
  });

  it('appends --mcp-config <path> --strict-mcp-config when set', () => {
    const args = buildArgs({
      cwd: '/x',
      prompt: 'p',
      allowedTools: [],
      maxTurns: 5,
      taskId: 't',
      mcpConfigPath: '/path/to/mcp.json',
    });
    const idx = args.indexOf('--mcp-config');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('/path/to/mcp.json');
    expect(args).toContain('--strict-mcp-config');
  });
});

describe('buildArgs — system prompt inline vs file', () => {
  it('passes --system-prompt inline by default', () => {
    const args = buildArgs({
      cwd: '/x',
      prompt: 'p',
      allowedTools: [],
      maxTurns: 1,
      taskId: 't',
      systemPrompt: 'small prompt',
    });
    const idx = args.indexOf('--system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('small prompt');
    expect(args).not.toContain('--system-prompt-file');
  });

  it('switches to --system-prompt-file when a file path is provided', () => {
    const args = buildArgs(
      {
        cwd: '/x',
        prompt: 'p',
        allowedTools: [],
        maxTurns: 1,
        taskId: 't',
        systemPrompt: 'x'.repeat(40_000),
      },
      '/tmp/sp.md',
    );
    const idx = args.indexOf('--system-prompt-file');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('/tmp/sp.md');
    expect(args).not.toContain('--system-prompt');
  });
});

describe('runClaude — oversized system prompt (Windows ENAMETOOLONG guard)', () => {
  it('completes with a >32k system prompt and cleans up its temp file', async () => {
    // Inline argv with a 40k-char system prompt exceeds the Windows
    // CreateProcess command-line limit (32,767 chars) and fails at spawn with
    // ENAMETOOLONG. The file-based fallback must keep the subprocess alive.
    const { readdirSync } = await import('node:fs');
    const countTempFiles = (): number =>
      readdirSync(tmpdir()).filter((f) => f.startsWith('wisp-sysprompt-')).length;
    const before = countTempFiles();
    const events = await collect(
      runClaude({
        cwd: tmpdir(),
        prompt: 'hi',
        allowedTools: [],
        maxTurns: 1,
        taskId: 't-bigsp',
        systemPrompt: 'x'.repeat(40_000),
        __mockBin: MOCK_BIN,
      }),
    );
    const types = events.map((e) => e.type);
    expect(types).toContain('task.completed');
    expect(types).not.toContain('task.failed');
    expect(countTempFiles()).toBe(before);
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

describe('extractAssistantTurnUsage', () => {
  it('extracts input+cache_creation as tokensIn and output as tokensOut', () => {
    const u = extractAssistantTurnUsage({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 999, // cache reads are intentionally excluded
          output_tokens: 20,
        },
      },
    });
    expect(u).toEqual({ tokensIn: 110, tokensOut: 20 });
  });

  it('returns null for non-assistant frames and assistant frames without usage', () => {
    expect(extractAssistantTurnUsage({ type: 'result', usage: { input_tokens: 5 } })).toBeNull();
    expect(extractAssistantTurnUsage({ type: 'assistant', message: { content: [] } })).toBeNull();
    expect(extractAssistantTurnUsage({ type: 'text-delta', text: 'hi' })).toBeNull();
  });
});
