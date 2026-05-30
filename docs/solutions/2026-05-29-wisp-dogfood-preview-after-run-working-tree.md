---
date: 2026-05-29
tags:
  [
    dogfooding,
    auto-merge,
    update-ref,
    preview-server,
    working-tree,
    vite-hmr-proxy,
  ]
files:
  - apps/dashboard-server/src/orchestrator/auto-merge.ts
  - apps/dashboard-server/src/orchestrator/preview-server.ts
  - apps/dashboard-server/src/routes/preview.ts
related:
  - 2026-05-29-better-sqlite3-node24-prebuilt-gap.md
  - 2026-05-18-wisp-v2-0-2-reliability-hardening-patterns.md
  - 2026-05-30-drizzle-hand-written-migrations-plan-recency.md
---

# Dogfooding v2.0.21 — preview-after-run gap (working tree never synced) + minor preview quirks

## Problem

Drove the full WISP lifecycle as a user, twice, on a fresh repo (Pomodoro
timer): create project → Sarah's brief interview → generate + lock plan →
run → live graph → release gate → Preview tab → change-request → iteration
(run 2). Both runs finished `success` with `Boot: PASS` release gates and a
genuinely good app (9/9 runtime smoke tests, 22 then 33 unit tests). But the
**Preview tab would not start after a successful run** — `pnpm dev` had no
`package.json` and no `node_modules` in the working tree, so the preview
process exited immediately (`running:false`).

Two smaller things surfaced too:

- A **stale `python -m http.server 5173`** left over from earlier testing
  squatted one loopback family of port 5173 while vite bound the other; the
  preview proxy hit the Python server and the iframe showed a Python 404.
- Loading the preview proxy URL **top-level** (not via the dashboard iframe)
  left `#root` empty — vite's HMR client spun on `[vite] server connection
  lost` (10k log lines) because the reverse-proxy forwards HTTP but not the
  HMR WebSocket. The **iframe path renders fine** (real UX is unaffected).

## Root cause

The headline gap is a **deliberate design tension**, not a crash bug:

- `auto-merge.ts` advances `main` to the run's `wisp/<runId>/result` via
  **`git update-ref refs/heads/main <sha>`** on the fast-forward path,
  explicitly commented "without touching any working tree (we don't want to
  disturb the user's checkout)". So after a run, `main` points at the result
  but the working tree + index still reflect the pre-run state. `git status`
  shows every result file as staged-`deleted` (index behind the ref).
- The **preview-server** (`preview-server.ts`) spawns `pnpm dev` in the
  project's `repoPath` working tree and **never installs deps**. The
  `runtime-verifier` boots fine during the run only because it works inside a
  task worktree that has both the files and `node_modules`.

So "don't clobber the user's checkout" (auto-merge) and "preview shows the
latest result" (preview tab, billed as an eye-test *between iterations*) pull
in opposite directions. The working tree is the user's; the result lives on a
ref the working tree was deliberately not moved to.

## Workaround (what unblocked it live)

```bash
cd <project repo>
git reset --hard main      # sync working tree to the result the run produced
pnpm install               # deps were only installed in the task worktrees
```

Then Preview → Start worked and the app rendered in the iframe; an App.tsx
edit hot-reloaded live (HMR works through the iframe). Also kill any stale
`python -m http.server <port>` before starting the preview.

## Candidate fix (decision pending — do NOT assume)

Respect the auto-merge design (never touch the user's checkout) by running
the **preview from a managed worktree of the latest result/`main`** under
`.harness-worktrees/<projectId>-preview`, with its own `pnpm install`,
instead of from the user's `repoPath`. That simultaneously (a) shows the
latest result, (b) leaves the user's checkout alone, (c) gets a clean
`node_modules`. Smaller stopgap: have `POST /preview/start` `pnpm install`
when `node_modules` is missing (closes the dep half only). The HMR-WS gap
needs the preview reverse-proxy to handle the WebSocket `upgrade` (or to
suppress vite's reconnect spam when no WS is wired).

## Verification

- Run 1: 6-node plan (arch → scaffold → reducer → ui → qa → runtime-verify),
  `success`, gate `READY` (Boot PASS / E2E PASS), runtime screenshot showed a
  polished dark Pomodoro timer with an SVG ring.
- Run 2 (change-request iteration): 5-node delta plan (arch-delta →
  dev-keyboard + dev-persistence → qa → runtime-verify), `success`; new
  keyboard-shortcut hint line rendered in the preview; persistence shipped
  with 11 unit tests; build 149 kB.
- Dashboard e2e (`pnpm --filter @wisp/e2e test`): **54 passed, 2 skipped**
  (isolated server on :4499, mock CLI) — routes, chat, a11y, i18n, tooltips.

## Lessons

- **`git update-ref` advances a branch ref but never touches the working
  tree or index.** That is the right tool when you must not disturb a user's
  checkout — but any consumer that runs *from* that working tree (here: the
  preview's `pnpm dev`) then sees stale files. Pair ref-only advances with a
  consumer that reads the ref, not the checkout.
- **A dev-server preview must own its dependencies.** Installing only inside
  per-task worktrees means the project root a preview spawns from has no
  `node_modules`. Either install on preview-start or serve from the worktree
  that already has them.
- **Reverse-proxying a vite dev server needs WebSocket upgrade handling**, or
  the HMR client spins forever on reconnect. The iframe path tolerated it;
  top-level did not.
- **Stale `http.server` / dev-server processes on Windows bind one loopback
  family** (`::` vs `::1`) and silently shadow a fresh server on the same
  port — the v2.0.2 tree-kill lesson applies to leftover test processes too.
