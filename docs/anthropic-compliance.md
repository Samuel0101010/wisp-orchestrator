# Anthropic Compliance — Architectural Commitments

## TL;DR

WISP wraps the official `claude` CLI. It does not extract
credentials, does not call Anthropic's API endpoints directly, and does not
re-implement subscription auth. The runtime defaults are tuned to look like
intensive human use rather than automated bulk traffic. CI enforces these
properties via static tests in `tests/compliance/`.

## Three commitments

### 1. No direct API endpoint access

The harness never sends an HTTP request to `api.anthropic.com`. All model
interaction goes through `claude -p` subprocesses. The `tests/compliance/
no-direct-anthropic.test.ts` test scans every source file in
`apps/`, `packages/` for forbidden strings: `api.anthropic.com`,
`anthropic-version`, `x-api-key`, `/.claude/credentials`, and
`readFileSync(...credentials`. Any match fails the build.

### 2. No credential extraction

The harness never reads `~/.claude/credentials` or any other on-disk
auth artifact. Subprocess auth is delegated entirely to the `claude`
binary via inherited HOME and standard auth precedence. The
`tests/compliance/no-credential-touch.test.ts` test asserts the
opposite — that `ANTHROPIC_API_KEY` is _actively deleted_ in
`subprocess.ts` and `auth.ts` before each spawn — so no implicit
fallback to API billing can occur.

### 3. Conservative traffic profile

Defaults are picked to mirror "intensive interactive use" rather than
"automated bulk worker":

| Setting                     | Default | Rationale                                                                      |
| --------------------------- | ------- | ------------------------------------------------------------------------------ |
| `maxParallel`               | 2       | One concurrent task per role at most. Lower than typical bulk-worker concurrency. |
| `budgetMinutes`             | 120     | Caps individual run wallclock.                                                 |
| `interTaskPacingMs`         | 5000    | Forces a 5-second gap between subprocess launches.                            |
| `autoResumeRateLimit`       | `false` | Rate-limit pauses require a manual user click to resume.                      |
| `consecutive-failure threshold` | 3   | Walker pauses after 3 task failures in a row.                                 |
| `auth-fail gate`            | enabled | Run-start blocks with HTTP 503 if last auth probe failed.                     |

## Three risk vectors and mitigations

### Risk: looking like a bot to Anthropic's traffic shaping

- _Vector_: tight subprocess loops with no inter-task pacing, high
  parallelism, automatic resumption after rate-limits.
- _Mitigation_: balanced defaults above + `consecutive-failure` walker
  pause + per-project daily-runs counter in the UI that turns red at
  ≥5 runs/24h.

### Risk: credential mishandling

- _Vector_: reading `~/.claude/credentials`, exporting OAuth tokens,
  re-implementing the auth dance.
- _Mitigation_: architectural choice to wrap the official CLI. Static
  tests prevent regression.

### Risk: ToS-grey commercial automation on a personal subscription

- _Vector_: shipping the harness as a "Claude API replacement" for
  business workloads.
- _Mitigation_: `WISP_AUTH_MODE=api` (forward-compatible flag stub
  in M1.5) signals that production / commercial use should provide an
  `ANTHROPIC_API_KEY` and pay per token. README ToS section
  documents the user's responsibility.

## How rate-limit pauses behave by default

1. The walker observes a rate-limit signal in `claude -p` stderr.
2. `pause('rate-limit', resumeAt)` is called — this aborts running
   tasks, persists the pause to SQLite, broadcasts `run.paused` over WS,
   and stores `resumeAt` so the UI can show a countdown.
3. With `WISP_AUTO_RESUME_RATE_LIMIT=false` (default), the walker
   waits indefinitely. The user must click "Resume Now" in the UI
   (which calls `POST /api/runs/:id/resume`).
4. With `WISP_AUTO_RESUME_RATE_LIMIT=true`, an in-process timer
   schedules a `walker.resume()` for `resumeAt`.

The rationale: when Anthropic signals "slow down," firing the same
request 5 hours later via a headless timer is the wrong shape of
behavior. A user-driven resume is at least an explicit, attended
restart.

## How consecutive-failure pauses behave

The walker tracks a single counter that increments on every terminal
task failure (worktree-add error, dep-merge conflict, subprocess
errored after retry, auto-commit failed, verification failed after
retry). Any task success resets the counter to 0. Reaching the
threshold of 3 calls `pause('consecutive-failures')` — same flow as
rate-limit pause, no auto-resume, user must click Resume.

## Known limitations

- API mode (`WISP_AUTH_MODE=api`) is a forward-compatible flag stub
  in M1.5; the boot-time auth-probe + startRun gate respect it (skip
  the probe and the gate) but no API-tier-specific code paths exist
  yet. M2+ may add direct-API support if the architectural review
  greenlights it.
- The auth-probe runs once at server boot. If the user runs `claude
  login` after server start, they must restart the server before the
  next run is gated correctly.
- Static compliance tests check source code; they cannot detect
  runtime behavior changes via dependency upgrades. Reviewers should
  read dep upgrades in addition to running the tests.
