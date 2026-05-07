---
date: 2026-05-07
tags: [orchestrator, claude-cli, subprocess, cold-resume, stream-json]
files:
  - packages/orchestrator/src/subprocess.ts
  - packages/orchestrator/src/walker.ts
  - packages/schemas/src/events.ts
related:
  - 2026-05-07-replan-branch-prefix-carried-over-deps.md
---

# Cold-resume was silently broken: capture `session_id` from leading stream-json frame

## Problem

After a server restart while a run was active, every interrupted task
re-launched from scratch with no `--resume <sessionId>` flag, losing all of
the agent's prior conversation context. The cold-resume path appeared to
work in tests but was effectively dead in production.

## Root cause

`subprocess.ts:mapCliEvent` only had cases for three frame types:
`text-delta`, `tool-use`, and `result`. The real `claude -p --output-format
stream-json` surfaces `session_id` in a leading `system`/`init` frame that
wasn't mapped. Consequence chain:

1. No event was emitted carrying the session id during a live run.
2. Walker's `t.sessionId` stayed `null` for every task.
3. `onTaskState({sessionId})` was never called, so `tasks.session_id` was
   never persisted to the DB.
4. On cold resume, `runtime.ts:resumeRun` filtered tasks via
   `else if (t.sessionId) initialState.resumableTasks.push(...)` — which
   found nothing, because no task ever had a sessionId.
5. Walker re-launched all interrupted tasks WITHOUT `--resume`, throwing
   away the conversation state.

The mock CLI didn't emit a system/init frame either, so all tests passed on
mock while the cold-resume path silently restarted from scratch in
production.

## Solution

Watch for `session_id` on **any** parsed line (not per-frame-type) and emit
once on first sight. New `task.session-id` event in the schema; walker
handles by setting `t.sessionId` and calling the existing onTaskState path
that already supports the column.

Why field-watching instead of per-frame: the CLI's exact frame layout is
opaque to us; `session_id` could appear on `system`, `init`, `result`, or a
future variant. Watching for the field across all frames is robust to CLI
evolution.

## Key snippets

```ts
// packages/orchestrator/src/subprocess.ts — inside the iterate() generator
let sessionIdEmitted = false;
child.stdout.on('data', (chunk: string) => {
  // ...existing line buffering...
  while ((nlIdx = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, nlIdx);
    stdoutBuf = stdoutBuf.slice(nlIdx + 1);
    const parsed = tryParseJson(line);
    if (!parsed) continue;
    if (!sessionIdEmitted) {
      const sid = (parsed as Record<string, unknown>).session_id;
      if (typeof sid === 'string' && sid.length > 0) {
        sessionIdEmitted = true;
        push({ type: 'task.session-id', payload: { taskId: opts.taskId, sessionId: sid } });
      }
    }
    const ev = mapCliEvent(parsed, opts.taskId);
    if (ev) push(ev);
  }
});
```

```ts
// packages/orchestrator/src/walker.ts — runTask() drain loop
} else if (ev.type === 'task.session-id') {
  if (!t.sessionId) {
    t.sessionId = ev.payload.sessionId;
    await this.deps.onTaskState(node.id, { sessionId: ev.payload.sessionId });
  }
}
```

```ts
// packages/schemas/src/events.ts — discriminated-union variant
z.object({
  type: z.literal('task.session-id'),
  payload: z.object({ taskId: z.string(), sessionId: z.string().min(1) }),
}),
```

## Verification

- Mock CLI extended with `MOCK_MODE=session-id` that emits a leading
  `system/init` frame + a `result` frame both carrying `session_id`.
- New `subprocess.test.ts` asserts: exactly **one** `task.session-id` event
  (emit-once invariant), ordered **before** `task.completed` (so the walker
  can persist it before any cold-resume reasoning kicks in).

## Lessons

- **Mocks that omit auxiliary frames hide capture bugs.** The mock-claude
  fixture emitted text-delta + tool-use + result, which covered the
  successful-run happy path but missed the leading system/init frame the
  real CLI uses to surface session id. When you add a watcher for a CLI
  field, also extend the mock to emit it — otherwise tests pass while
  production silently fails.
- **"If X exists, then Y" filters are load-bearing on someone setting X.**
  `runtime.ts:resumeRun` had `else if (t.sessionId)` — looked correct in
  isolation but was vacuous because nothing ever wrote `t.sessionId`. Trace
  every `if (foo)` that matters: where is foo set? If you can't answer
  immediately, foo might never be set.
- **Watch for fields, not for frame types, when the CLI's frame layout is
  external and may evolve.** Per-frame-type cases break when the CLI
  reshuffles which frame carries which field. A "scan every frame for this
  field, emit once" pattern is robust to upstream churn.
- **This was found via cross-cutting behavioral review** (round 5's "Mock
  CLI vs real CLI semantic drift" flow), not static review of subprocess.ts.
  A static reviewer reading the file in isolation has no reason to question
  why session_id isn't extracted — the bug only surfaces when you ask "how
  does cold-resume actually find the sessionId at runtime?"
