---
date: 2026-05-29
tags: [better-sqlite3, native-module-prebuilds, node-abi, vitest-fake-timers, claude-cli-config]
files:
  - package.json
  - packages/orchestrator/src/walker.ts
  - apps/dashboard-server/src/routes/chat.ts
  - scripts/launch-dashboard.sh
related:
  - 2026-05-18-wisp-v2-0-2-reliability-hardening-patterns.md
  - 2026-05-29-wisp-dogfood-preview-after-run-working-tree.md
  - 2026-05-30-drizzle-hand-written-migrations-plan-recency.md
---

# v2.0.21 — Node-24 install failure (better-sqlite3 prebuilt gap) + chat fixes

## Problem

A fresh `/plugin install` on a non-developer machine failed "on the Node version." Separately, after wiring an inter-agent hand-off write, a previously-7 ms walker test started timing out at 5 s; and chat file uploads could not be read by the manager (its turn hit max-turns → the server returned 502).

## Root cause

1. **Prebuilt coverage is per Node ABI, not per "latest".** `better-sqlite3@11.10.0` ships prebuilt binaries only up to Node 23 (ABI 131). A fresh nodejs.org install today gives Node 24 (ABI 137), so `prebuild-install` misses → its `node-gyp rebuild` fallback runs → needs a C++ toolchain (VS Build Tools / Xcode CLT) a normal box lacks → `pnpm install` aborts. CI/dev boxes stay green because they run Node 22 (prebuilt exists) + have a toolchain.
2. **`await` in a hot path under vitest fake-timers.** The hand-off write was added as `await this.deps.writeHandoff?.(...)`. Even when `writeHandoff` is undefined (`await undefined`), the extra microtask boundary desynced the walker's fake-timer choreography → the run promise never resolved → 5 s timeout.
3. **Upload files are stored uuid-prefixed.** The chat manifest told the manager the original filename, but the file on disk is `<uuid>-<name>`, so `Read <name>` in the cwd failed.

## Solution

1. Pin `better-sqlite3` to **12.9.0** (override + specifiers), regenerate the lockfile. 12.9.0 ships prebuilds for Node 20–25 (ABI 115/127/131/137/141). **NOT 12.10.0** — it dropped the Node-20 ABI (115). Verified the matrix against the GitHub release assets.
2. Make the hand-off write **fire-and-forget** — advisory writes must never `await` in the task hot path.
3. Manifest gives the manager the **absolute `storagePath`** from the per-thread `index.json`, not the bare filename.

## Key snippets

```jsonc
// package.json — pnpm.overrides
"better-sqlite3": "12.9.0"   // 12.10.0 drops Node-20 (ABI 115); 12.9.0 covers 20–25
```

```bash
# Enumerate a native module's prebuilt ABI matrix BEFORE bumping:
node -e 'fetch("https://api.github.com/repos/WiseLibs/better-sqlite3/releases/tags/v12.9.0",{headers:{"User-Agent":"x"}}).then(r=>r.json()).then(j=>console.log([...new Set(j.assets.map(a=>(a.name.match(/node-v(\d+)/)||[])[1]).filter(Boolean))].sort()))'
```

```ts
// walker.ts — advisory hand-off, fire-and-forget (no await in the hot path)
void Promise.resolve(this.deps.writeHandoff?.({ taskId, role, summary, status: 'done', branch })).catch(() => {});
```

## Verification

- Fresh-clone (tracked-files copy, no node_modules/dist) → launcher → `pnpm install --frozen-lockfile` + build + spawn → `/api/health` `{ok:true, authProbe.ok:true}`; an idempotent re-run reused the live server instead of spawning a second.
- Chat browser-validated: Enter sends / Shift+Enter newline (DOM value had `\n`); Marcus read two uploaded files + reported both markers; create-project-via-chat produced a repo with `.git` + an initial commit.
- 759 tests green after the fire-and-forget fix (the walker test went back to ~7 ms).

## Lessons

- **Before bumping a native dep, enumerate its prebuilt ABI matrix against the Node versions users actually have.** "Latest" can drop an ABI you still support (12.10.0 dropped Node 20). The launcher floor (Node ≥ 20.10) had no upper-bound awareness, so it waved Node 24 straight into the failing compile.
- **Never add `await` to a hot path covered by fake-timer tests.** Even `await undefined` adds a microtask tick that can deadlock the test's timer choreography. Advisory side-effects → fire-and-forget.
- **The server returns 502 by design when an agent turn fails** (`turn.failed` → `reply.code(502)`); a 502 in the chat UI usually means the manager's `claude -p` turn failed, not an HTTP-layer bug.
- **`~/.claude.json` can corrupt under many concurrent `claude` subprocesses** (observed during parallel agent-teams + workflows + chat turns at once). The CLI self-recovers to a minimal valid config, but it is a real risk for WISP's parallel-agent runs — worth a hardening look.
- A sub-agent that verifies only `build` + `typecheck` (not the package's vitest suite) will miss test regressions like the fake-timer hang — always run the affected package's tests.
