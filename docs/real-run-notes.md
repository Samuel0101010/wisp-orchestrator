# Real-Claude Smoke Run — M1.5 Stage G

First end-to-end validation of Agent Harness against the real `claude` CLI on a
Claude Max subscription, against a fresh empty git repository. Captures the gap
between mock-CLI tests and reality, plus measured timings, surprises, and the
foundation-level claims that real-Claude can confirm but mocks cannot.

## Setup

- Date: 2026-05-05
- Host: Windows 11, Node 20, `claude` 2.1.128
- Branch under test: `m1.5/real-claude-fixes` on top of merged `m1.5/foundation-hardening`
- Test repository: empty git repo at `C:/Users/samue/AppData/Local/Temp/harness-real-1`
  (single empty `init` commit on `main`)
- Goal: "Add an exported `hello(name)` function returning 'Hello, <name>' to a
  TypeScript module at `src/hello.ts` plus a vitest test"
- Server: `node apps/dashboard-server/dist/server.js` on port 4502 with
  `HARNESS_INTER_TASK_PACING_MS=5000`,
  `HARNESS_DATA_DIR=$PWD/data/dev-store-real`

## What the foundation needed to prove

Stage A's load-bearing claim is that an **artifact written by the architect's
subprocess survives into the developer's working directory** via git-branch
chaining + auto-commit. Mock-CLI cannot validate this — the mock writes
nothing — so the entire vertical slice depends on real-Claude evidence.

**Claim validated.** After the run, the test repo contains:

```
$ git -C C:/Users/samue/AppData/Local/Temp/harness-real-1 branch --all
  harness/93478bd3.../architect-plan
+ harness/93478bd3.../dev-hello-module
* main

$ git log --oneline --graph --all
* ac51b0f harness: architect-plan
* 7d03b53 init
```

The `harness/.../architect-plan` branch carries the architect's auto-commit
(`harness: architect-plan`) on top of the original `init`. The
`harness/.../dev-hello-module` branch was created off
`harness/.../architect-plan` (Stage A2 chaining) and inherited `architecture.md`
+ `tasks.md` produced by the architect. The developer wrote `package.json`,
`tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/hello.ts`, and
`src/hello.test.ts` in that worktree — visible on disk under
`C:/Users/samue/AppData/Local/Temp/.harness-worktrees/`. Without Stage A's
chaining + auto-commit, dev would have started from an empty `main` and the
architecture documents would have been gone.

The dev's `src/hello.ts` is exactly:

```ts
export function hello(name: string): string {
  return `Hello, ${name}`;
}
```

and `pnpm build`, `pnpm test`, `pnpm lint` all succeed when executed manually
in the worktree (3/3 vitest tests pass).

## Bugs the smoke run surfaced (all fixed before validation)

### 1. Auth probe missing `--verbose`

`packages/orchestrator/src/auth.ts` invoked
`claude -p --output-format=stream-json --max-turns 1` without `--verbose`.
Modern claude rejects this combination at startup with
`When using --print, --output-format=stream-json requires --verbose`. The
probe therefore always reported the subscription as unauthenticated even
when the user was logged in. **Fix:** add `--verbose` to the probe args,
mirroring `subprocess.ts` which already had it for task subprocesses.

### 2. False-positive rate-limit on the CLI's startup `rate_limit_event`

The `claude` CLI emits an informational JSON line at session start:

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed", ...}}
```

Our `detectRateLimit` heuristic matched the generic `/rate.?limit/i` pattern
on the event name itself and incorrectly classified every successful
invocation as a rate-limit hit. Plan generation bubbled up as `503
rate-limit` from `POST /api/projects/:id/plan` after ~7 seconds.
**Fix:** strip JSON lines that match `"type":"rate_limit_event"` AND
`"status":"allowed"` before scanning. Three new regression tests cover the
informational/throttle distinction.

### 3. Walker hangs when a task fails terminally with downstream pending tasks

After a terminal upstream failure, the walker's dispatch loop saw `ready=[]`,
`countRunning=0`, but downstream tasks were still `pending` (deps would never
satisfy). The `allDone` check required every task to be in a terminal state,
so the walker idled forever instead of finalizing as `failure`. **Fix:**
synchronously cancel pending tasks whose deps are terminally non-done before
the finalize check; expand `anyFailed` to also treat `cancelled` as failure
for outcome purposes. Confirmed end-to-end: when dev failed in the second
real run, qa-verify was correctly cancelled and the run finalized as
`failure` instead of hanging.

### 4. Planner emitted prose for `successCriteria.custom`

The architect node's planner-generated criterion was a prose description
("architecture.md and tasks.md exist at project root..."), which the
verification layer attempted to exec as a shell command. cmd.exe replied
"Der Befehl 'architecture.md' ist entweder falsch geschrieben...".
**Fix iteration 1:** suggest `test -f architecture.md && test -f tasks.md`
in the planner prompt — but `test` is bash-only, not on cmd.exe's PATH.
**Fix iteration 2:** recommend a node-based check
`node -e "require('fs').accessSync('architecture.md');..."` which is
cross-platform. After this fix, the planner consistently emits the
`node -e` form.

## Measured timings

- Auth probe: 9–10 s (cold start of `claude`)
- Plan generation: 15 s (warm cache) to 69 s (cold)
- Architect (opus, 1 file write of architecture.md + tasks.md): 2 min 13 s
- Developer (sonnet, full bootstrap of TS + vitest project): ~14 min before
  hitting the verification gate
- Total goal-to-failure wall clock: ~17 min

The 14 min for the developer was unexpectedly long. Sonnet under `claude -p`
spent significant time iterating — exact token counts unavailable (see
operational notes below).

## Operational issues — not foundation, surface in real runs

### Token / turn counters stuck at 0/0 in UI

Throughout every run, `tokensInTotal`/`tokensOutTotal` and `turnsTotal`
remained 0 even though the subprocesses obviously consumed real tokens (the
architect produced multi-thousand-character documents). The `task.usage`
event parser in `subprocess.ts` is most likely not matching the shape that
modern `claude -p --output-format=stream-json --verbose` emits. The CLI's
final `result` line carries usage data (e.g. `total_cost_usd`,
`input_tokens`, `output_tokens`, `cache_creation_input_tokens`), so the data
is there to be parsed — the harness just isn't picking it up. Out of scope
for M1.5; logged for a follow-up.

### Dev verification fragile in fresh-bootstrap scenarios

In the third run, dev's first attempt finished cleanly (subprocess emitted
`task.completed`), but the harness's verify gate (`pnpm build`, `pnpm test`,
`pnpm lint`) failed. The retry passed the verification error back into the
prompt; the second subprocess crashed with `exit code 1`. Manual rerun of
the same three commands in the same worktree afterwards succeeded (tsc
clean, 3/3 vitest tests green). Likely causes:

- The retry prompt may have grown too large with embedded verification output
  and confused the model.
- The dev's `prebuild`/`pretest`/`prelint` hooks each gate on
  `existsSync('node_modules')` then call `execSync('pnpm install')`. If the
  first `pnpm install` ran during `pnpm build` and the lockfile was being
  written while `pnpm test` started, the second install may have raced.

Mitigations to consider in M2:

- Cap retry-prompt embedded error to first-N + last-N lines.
- Run `pnpm install` (or equivalent) once before the verify gate, not
  per-command.
- Make the verification step itself surface its output as a `harness.verify`
  event so we can post-mortem without rerunning.

## Quota observations

Three real-Claude runs (two failed-fast at architect, one ran to dev-fail).
Anecdotally felt like a normal interactive multi-turn session — no rate-limit
hits, no throttling. The conservative defaults (`maxParallel=2`,
`interTaskPacingMs=5000`) kept the request cadence calm.

Total subscription cost: not directly measured because the UI tokens
counter is broken (see above). Manual probe of a single-turn opus call
showed `total_cost_usd: 0.222` for ~35k cache-creation input tokens, so
order-of-magnitude estimate for the 17-min run is ~$1–3 of subscription
budget consumed.

## What is now actually validated end-to-end

| Capability | Real-Claude validated? |
|---|---|
| Auth probe + run-start gate | ✅ |
| Plan generation against real Claude | ✅ |
| Architect subprocess streams complete + verifies | ✅ |
| **Stage A — worktree chaining + auto-commit** | **✅ via inspection of harness branches + on-disk worktrees** |
| Walker dep-failed cancellation + finalize as failure | ✅ |
| First-run modal flow + confirm dialog | ✅ |
| Cross-platform custom-criteria verification | ✅ |
| Compliance static tests | ✅ (CI) |
| Result branch finalize (Stage A5) | ❌ — only fires on `outcome='success'`; no successful run yet |
| Diamond-merge (Stage A4) | ❌ — planner produces linear DAGs for trivial goals |
| Rate-limit pause + manual resume | ❌ — never tripped |
| Consecutive-failures pause | ❌ — threshold not reached |

The unvalidated rows are not foundation defects; they require either a
specific failure scenario or a richer goal/team than the smoke test exercises.

## Conclusion

The M1.5 hardening achieved its primary load-bearing goal: **on a real Claude
Max account, an artifact produced by one subprocess survives into the
working directory of the next subprocess via the git-branch chain.** Without
Stage A this would have failed at the developer step every time; with
Stage A the dev had `architecture.md` + `tasks.md` already in its worktree
and bootstrapped a working TypeScript project from them.

The harness still has fragility above the foundation layer (verify-gate
robustness, telemetry parsing) which the smoke surfaced and which belongs
in M2's scope, not M1.5.

---

# v1.0 Stage 1 — foundation hardening (2026-05-05)

Branch `v1.0/foundation-hardening`, commits `132fd4d..101197b`.

## v1.0 Pfad A run — Stage A5 result branch validated

**Goal:** "Write a single text file named result.txt at the project root
containing exactly the line: HELLO WORLD." Three-role haiku team, fresh
repo `harness-r1`, port 4503, run id `6447176a-3ec2-47e7-8294-8539dfa3244e`
(third attempt on plan `1a7305bb`).

**Outcome:** ✅ `status=completed, outcome=success`. Result branch
`harness/6447176a-3ec2-47e7-8294-8539dfa3244e/result` created and contains
`architecture.md`, `tasks.md`, `result.txt` (= "HELLO WORLD").

| Task | Status | Tokens in | Tokens out | Turns | Duration |
|---|---|---|---|---|---|
| architect-1 | done | 9 451 | 3 613 | 11 | 71.2 s |
| developer-1 | done | 51 090 | 1 363 | 9 | 43.8 s |
| qa-1 | done | 4 453 | 334 | 2 | 10.4 s |
| **total** | — | **64 994** | **5 310** | **22** | **125.4 s wall** |

`tokensIn` non-zero across the board, confirming Task 1.4's
`task.usage` parser fix against the real `claude -p` result frame.

## Diagnoses surfaced before success

The first two attempts on the same goal failed and exercised the new
`harness.verify-failed` event end-to-end:

- **Attempt 1** (plan `30bbc7de`, run `f5fca233`): architect's first
  subprocess returned exit 0 but never invoked the `Write` tool, so the
  custom verify gate `accessSync('architecture.md')` failed. Retry
  failed identically. Walker emitted two `harness.verify-failed` events
  (attempt 1 + 2) with full failure payload — kind, cmd, exitCode, tail,
  output. Fixed by tightening the architect/developer/qa system prompts
  ("you MUST use the Write tool, do not just chat").
- **Attempt 2** (plan `1a7305bb`, run `cd569d96`): architect retried
  successfully on second attempt, developer succeeded, but the QA verify
  gate emitted by the planner was CRLF-naive
  (`s !== 'HELLO WORLD\n' && s !== 'HELLO WORLD'`) and the dev wrote
  `result.txt` with Windows CRLF line endings. Both QA attempts failed
  the gate. Patched the plan's QA `successCriteria.custom` in SQLite to
  strip a trailing `\r?\n$` before comparison; re-ran on the same plan
  → success.

**Foundation behaviors validated against real Claude:**

| Capability | Status |
|---|---|
| `task.usage` parser reads modern result-frame | ✅ tokensIn/Out non-zero |
| `harness.verify-failed` event with full payload | ✅ fired on every miss with `kind`, `cmd`, `exitCode`, `tail`, `output` |
| Worktree chaining (Stage A1-A3) | ✅ developer worktree carried architect's commits |
| Auto-commit after success (Stage A2) | ✅ each task committed by harness, no manual git inside agents |
| Result branch finalize on success (Stage A5) | ✅ first-ever validation — `harness/<runId>/result` is the merge of qa-1's branch |
| Cancel downstream tasks on upstream failure (Stage G3) | ✅ attempts 1 & 2 cancelled developer + qa with `cancelled: upstream dep failed` |
| Retry-error truncation in retry prompt | not visible (small diffs); machinery in place |

**Open lessons for the planner prompt:**

1. The planner sometimes emits CRLF-naive verify gates on Windows. Prose
   in `DAG_SCHEMA_BLOCK` already advises cross-platform; needs an
   explicit CRLF-tolerance example (`replace(/\r?\n$/,'')` before string
   compare). Out of scope for Stage 1 — captured as fodder for the M5
   planner-quality work.
2. Haiku architects routinely fail the first verify-pass when the gate
   requires file existence — they describe instead of invoking `Write`.
   The retry-once + verify-event approach handled it gracefully; the
   stronger team prompt ("you MUST use Write") gets the architect over
   the line on the first attempt of attempt 3.
