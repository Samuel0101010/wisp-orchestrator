---
date: 2026-05-07
tags: [better-sqlite3, sqlite, concurrent-writes, memory-mcp, busy-timeout]
files:
  - packages/memory-mcp/src/store.ts
related: []
---

# better-sqlite3: concurrent writers throw SQLITE_BUSY immediately without busy_timeout

## Problem

Per-run `memory.db` was opened by N parallel task subprocesses at once
(each task spawned its own `agent-harness-memory` MCP server pointing at the
same file). With the pool's `maxParallel=2` default, two concurrent
`INSERT ... ON CONFLICT` writes raced for SQLite's write lock; the second
writer's `.run()` threw `SQLITE_BUSY` immediately, surfaced to the agent as
a tool error.

## Root cause

`journal_mode = WAL` allows readers and one writer to coexist, but it does
**not** eliminate write-write contention. Two writers must serialize via
SQLite's write lock. better-sqlite3's default `busy_timeout` is `0` — when
the second writer encounters the lock, it doesn't wait, it throws.

The store had a comment claiming "the harness writes through a single
per-task subprocess so contention is low" — half-true (each TASK has one
writer) but missed that the pool runs N tasks concurrently, each with its
own MCP server, so there are genuinely N concurrent better-sqlite3
connections to the same file.

## Solution

One pragma in the constructor right after `journal_mode = WAL`:

```ts
this.db.pragma('journal_mode = WAL');
this.db.pragma('busy_timeout = 5000');
```

Five seconds covers any reasonable serialized-write window (a single set()
operation completes in microseconds; 5s of retries handles ~10⁶ ops worth
of contention without silent infinite hangs).

## Key snippets

```ts
// packages/memory-mcp/src/store.ts
constructor(path: string) {
  this.db = new Database(path);
  this.db.pragma('journal_mode = WAL');
  // Per-run memory.db is opened by N parallel task subprocesses (each one
  // spawns its own memory-mcp server pointing at the same file) under the
  // pool's maxParallel concurrency. WAL serializes writes, but better-
  // sqlite3's default busy_timeout is 0 — the second writer's `INSERT ON
  // CONFLICT` would throw `SQLITE_BUSY` immediately on lock contention,
  // surfacing as a tool error to the agent. Five seconds of retry covers
  // any reasonable serialized-write window without making genuinely
  // deadlocked operations hang forever.
  this.db.pragma('busy_timeout = 5000');
  this.db.exec(/* CREATE TABLE ... */);
}
```

## Verification

- Existing memory-mcp tests (27 passing) unchanged — they don't exercise
  concurrent writers but the pragma is a constructor-time setting that
  doesn't affect single-writer correctness.
- Production verification deferred until next real-Claude run with a
  template that uses memory_set from multiple roles in parallel
  (architect+developer both calling memory.set during overlapping
  windows).

## Lessons

- **`journal_mode = WAL` is necessary but not sufficient for concurrent
  writers.** WAL handles the read-during-write case. For write-during-write
  you also need `busy_timeout` set to something non-zero, or your second
  writer fails immediately.
- **Comments that justify omitting safety should be reviewed periodically.**
  The store's "contention is low" comment hid the bug. The comment was
  written when the system had one writer per run; later changes (per-task
  MCP server spawn) made it inaccurate but the comment didn't update.
- **Default to defensive pragmas on better-sqlite3 connections.** A
  reasonable boilerplate for any DB that may see concurrent processes:

  ```ts
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');  // if FKs are declared
  ```

- **The fix is one line; the bug took 5 audit rounds to surface.** None of
  the prior audits exercised the "two MCP servers writing the same file
  simultaneously" scenario. Cross-cutting behavioral review (round 5's
  "Memory MCP under 2 parallel writers" flow) is what finally caught it.
