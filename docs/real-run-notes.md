# Real-Claude Smoke Run — M1.5 Stage G

First end-to-end validation of Agent Harness against the real `claude` CLI on a
Claude Max subscription, against a fresh empty git repository. Captures the gap
between mock-CLI tests and reality, plus measured timings, surprises, and the
foundation-level claims that real-Claude can confirm but mocks cannot.

## Setup

- Date: 2026-05-05
- Host: Windows 11, Node 20, `claude` 2.1.128
- Branch under test: `m1.5/real-claude-fixes` on top of merged `m1.5/foundation-hardening`
- Test repository: empty git repo at `C:/Users/dev/AppData/Local/Temp/harness-real-1`
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
$ git -C C:/Users/dev/AppData/Local/Temp/harness-real-1 branch --all
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
`C:/Users/dev/AppData/Local/Temp/.harness-worktrees/`. Without Stage A's
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

---

## v1.0 Pfad B run — full-stack hello.ts + vitest with preflight

**Goal:** "Add an exported hello(name) function returning the string `Hello, <name>` to a new TypeScript module at src/hello.ts plus a vitest test at src/hello.test.ts. Initialise package.json with vitest and typescript as dev dependencies; the test must pass via `pnpm test`."

Three-role haiku team, fresh repo `harness-r2`, port 4504, run id
`07f1c0e0-36fc-4546-b610-a34312cf6bac` on plan `d5ac6665` (second
attempt; first failed with the `CI=true` bug fixed in commit `1851e7e`
below).

**Outcome:** ✅ `status=completed, outcome=success`. Result branch
`harness/07f1c0e0-36fc-4546-b610-a34312cf6bac/result` carries:
`architecture.md`, `tasks.md`, `package.json`, `tsconfig.json`,
`pnpm-lock.yaml`, `src/hello.ts`, `src/hello.test.ts`.

`src/hello.ts`:
```ts
export function hello(name: string): string {
  return `Hello, ${name}`;
}
```

| Task | Status | Tokens in | Tokens out | Turns | Duration |
|---|---|---|---|---|---|
| arch-scaffold | done | 6 366 | 1 770 | 4 | 21.0 s |
| dev-implement | done | 8 837 | 2 069 | 13 | 64.4 s |
| qa-verify | done | 9 315 | 2 811 | 20 | 91.3 s |
| **total** | — | **24 518** | **6 650** | **37** | **176.7 s wall** |

**Planner emitted preflight on dev + qa**, confirming Task 1.3's
DAG_SCHEMA_BLOCK update is steering the planner correctly:
- `dev-implement.successCriteria` = `{preflight: "pnpm install", test: "pnpm test"}`
- `qa-verify.successCriteria` = `{preflight: "pnpm install", build: "npx tsc --noEmit", test: "pnpm test"}`

**Diagnosis arc on the way to success:**

1. **First r2 run** (run `08a555e3`, before fix): architect + dev
   succeeded; QA preflight failed with
   `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` — pnpm refused to
   clobber the chained-in `node_modules` because the verifier
   subprocess had no TTY. New `harness.verify-failed` event carried
   the full pnpm error message verbatim, making root-cause
   identification trivial.
2. **Foundation patch** (commit `1851e7e`): set `env: { CI: 'true' }`
   in `verification.ts`'s `defaultExec`. This is the canonical pnpm
   non-interactive switch. Re-ran on the same plan id.
3. **Second r2 run** (run `07f1c0e0`, after fix): architect succeeded;
   dev's first attempt failed preflight with `ERR_PNPM_NO_PKG_MANIFEST`
   (architect described package.json in `architecture.md` but didn't
   write it); dev's retry created package.json + ran install + wrote
   src/ + tests, all gates passed. QA succeeded clean. Result branch
   finalized.

**End-to-end Stage-1 validations against real Claude:**

| Task 1.x capability | Pfad A | Pfad B |
|---|---|---|
| 1.1 `harness.verify-failed` event with full payload | ✅ both attempts | ✅ both runs |
| 1.2 retry-prompt cap | not exercised (small errors) | dev recovered on retry — no crash |
| 1.3 `successCriteria.preflight` runs first + short-circuits | not used | ✅ planner emitted it; ran before build/test/lint |
| 1.4 `task.usage` parses result frame | ✅ tokensIn 64,994 | ✅ tokensIn 24,518 |
| 1.5 verify-failed persists in events table | ✅ inspectable via SQLite | ✅ inspectable via SQLite |
| Stage A5 result branch finalize | ✅ first ever success | ✅ |
| New: `CI=true` keeps pnpm install non-interactive | n/a | ✅ |

**Open issues / future-work signals:**

- The architect frequently describes files (package.json, tsconfig)
  in `architecture.md` instead of writing them. Dev recovers via the
  retry, but a stronger architect prompt or a "scaffold" sub-role
  (M2-style team customisation) would eliminate one full retry cycle
  per run.
- No diamond-merge / parallel-task validation here — both runs were
  linear DAGs. Stage A4 still unvalidated against real Claude;
  M2's variable-team work should provide a goal that exercises it.

---

# v1.0 Stage 2 — variable team (2026-05-05)

Branch `v1.0/m2-variable-team`, commits `1f47327..ba364bc`.

## v1.0 4-role real-Claude run (M2 acceptance)

**Goal:** "Add a TypeScript module src/calc.ts exporting add(a,b)
returning a+b, plus a Vitest test src/calc.test.ts asserting at least
the happy path. Initialise package.json with vitest+typescript as
devDependencies. Also write a README.md at the project root that
documents the add() function with one usage example."

Four-role haiku team — architect / backend-dev / frontend-dev / qa.
Fresh repo `harness-r3`, port 4505, run id
`abd5e092-d99b-4b7f-a84f-83222c2da459` on plan `8e8e4a48` (second
attempt; first failed with the platform-detection bug fixed in
commit `ba364bc` below).

**Outcome:** ✅ `status=completed, outcome=success`. Result branch
`harness/abd5e092-d99b-4b7f-a84f-83222c2da459/result` carries:
`architecture.md`, `tasks.md`, `package.json`, `tsconfig.json`,
`README.md`, `src/calc.ts`, `src/calc.test.ts`, `node_modules/`.

`src/calc.ts`:
```ts
export function add(a: number, b: number): number {
  return a + b;
}
```

| Task | Role | Status | Tokens in | Tokens out | Turns | Duration |
|---|---|---|---|---|---|---|
| architect-scaffold | architect | done (1st attempt) | 6 488 | 1 896 | 4 | 22.9 s |
| backend-implementation | backend-dev | done (1st attempt) | 8 966 | 2 095 | 13 | 61.7 s |
| frontend-readme | frontend-dev | done (1st attempt) | 10 083 | 2 792 | 15 | 58.6 s |
| qa-verify | qa | done (1st attempt) | 8 819 | 2 455 | 17 | 75.6 s |
| **total** | — | — | **34 356** | **9 238** | **49** | **218.9 s wall** |

Every task passed verify on its first attempt — this is the cleanest
end-to-end run to date.

## Stage A4 fan-in merge first-time validated

The planner emitted `qa-verify.deps = ['backend-implementation', 'frontend-readme']` —
a true diamond / fan-in topology. Resulting git log:

```
*   merge harness/<runId>/qa-verify       ← Stage A5 result-branch finalize
|\
| * qa-verify
| *   merge harness/<runId>/frontend-readme  ← Stage A4 dep-branch fan-in
| |\
| | * frontend-readme
| |/
| * backend-implementation
| * architect-scaffold
|/
* init
```

The inner merge commit ("merge harness/.../frontend-readme") is the
first-ever real-Claude validation of `mergeBranchesInWorktree` — when
qa-verify started, the walker added a worktree from the
backend-implementation branch (its first dep) and merged the
frontend-readme branch into it before the qa subprocess ran.

## Diagnosis surfaced before success

**First r3 run** (run `5e97d92a`, before fix): architect succeeded;
backend-dev's first attempt failed `npx tsc --noEmit` (haiku put
`include` inside `compilerOptions` instead of at the root of
tsconfig.json — fixed itself on retry). But both attempts then failed
`npx vitest run` with rollup native-binding errors. Inspecting the
worktree's `node_modules/@rollup/` showed only `rollup-linux-x64-gnu`
and `rollup-linux-x64-musl` — no Windows binary, despite running on
Windows.

Root cause: `pnpm config get os` returned `linux` (a stale line in
the user's global pnpm config at `~/AppData/Local/pnpm/config/rc`)
which overrode platform detection. pnpm therefore picked linux-only
optionalDeps for rollup on a Windows host.

**Foundation patch** (commit `ba364bc`): inject
`npm_config_os: process.platform` and `npm_config_arch: process.arch`
into `verification.ts` `defaultExec` env. This forces pnpm/npm to
respect the actual runtime platform regardless of any stale global
config, and selects the correct platform-specific optional-deps every
time.

## Stage 2 capabilities validated

| M2 capability | Status |
|---|---|
| Schema accepts roles array (1..8, kebab-case unique) | ✅ — 4-role team round-trips through PUT/GET |
| Planner enumerates roles literally + uses them | ✅ — all 4 custom roles appear in plan, no slot drift |
| Walker resolves agent via `team.roles.find` | ✅ — no hardcoded slot lookup |
| Stage A4 merge-of-dep-branches in worktree | ✅ — first real-Claude validation of the diamond fan-in |
| Migration 0002 (idempotent UPDATE) | ✅ — smoke + in-memory rewrite test |
| New `npm_config_os/arch` injection | ✅ — pnpm picked correct rollup binary on retry |

## Open lessons

- Haiku's first-attempt tsconfig.json sometimes nests `include` inside
  `compilerOptions`. The retry-with-error-context (Stage 1 cap) lets
  it self-correct — confirmed live this run on backend-dev attempt 1
  → 2. The truncation cap from Task 1.2 kept the retry prompt sane.
- The result branch carried `node_modules/` (not gitignored). For
  personal-use this is fine; a future task could add a default
  `.gitignore` written by the architect's scaffold so result branches
  stay light.

---

# v1.0 Stage 3 — shared-memory MCP (2026-05-05)

Branch `v1.0/m3-memory-mcp`, commits `c46f5da..07e384c`.

## v1.0 memory roundtrip real-Claude run (M3 acceptance)

**Goal:** "Architect designs a greeting module spec and stores it in
memory under arch.spec. Developer reads memory.get(arch.spec) and
implements src/greet.ts with the greet(name) function returning
Hello <name>!, plus a Vitest test. QA verifies the implementation
matches the spec by reading memory.get(arch.spec) and running pnpm
test."

Three-role haiku team — architect / developer / qa, each with
`mcp__agent-harness-memory__memory_*` tools whitelisted. Fresh repo
`harness-r4`, port 4506, run id `a43046ff-5c06-41b7-9049-c9eec66274e4`
on plan `3179097f` (second attempt; first failed silently because the
default team's allowedTools used the wrong tool-name format — fixed
in commit `07e384c` below).

**Outcome:** ✅ `status=completed, outcome=success`. Result branch
`harness/a43046ff-5c06-41b7-9049-c9eec66274e4/result` carries:
`architecture.md`, `tasks.md`, `package.json`, `tsconfig.json`,
`src/greet.ts`, `src/greet.test.ts`.

`src/greet.ts`:
```ts
export function greet(name: string): string {
  return `Hello ${name}!`;
}
```

| Task | Role | Status | Tokens in | Tokens out | Turns | Duration |
|---|---|---|---|---|---|---|
| arch-spec | architect | done (1st) | 5 699 | 1 911 | 4 | 20.2 s |
| dev-greet | developer | done (1st) | 9 538 | 4 005 | 16 | 46.8 s |
| qa-verify | qa | done (1st) | 8 463 | 2 679 | 16 | 76.4 s |
| **total** | — | — | **23 700** | **8 595** | **36** | **143.4 s wall** |

## Memory DB contents (the real validation)

`<HARNESS_DATA_DIR>/memory/<runId>.db` after the run:

```
keys: 2

--- arch.spec (size=764, updated=2026-05-06T00:02:28.454Z) ---
{"modulePath":"src/greet.ts","functionSignature":"export function greet(name: string): string","behavior":"Returns the literal string 'Hello <name>!' where <name> is replaced with the input parameter. No trimming or normalization.","examples":[{"input":"Alice","output":"Hello Alice!"},{"input":"Bob","output":"Hello Bob!"},{"input":"","output":"Hello !"},{"input":"José","output":"Hello José!"},{"input":"  ","output":"Hello   !"}],"edgeCases":[{"case":"Empty string","behavior":"Returns 'Hello !' — literal substitution"},...]}

--- dev.notes (size=234, updated=2026-05-06T00:04:20.663Z) ---
Created package.json, src/greet.ts with greet(name) returning `Hello ${name}!`, and src/greet.test.ts with 5 tests covering happy path and all edge cases (empty string, whitespace, unicode); added tsconfig.json for TypeScript support.
```

**The acid test:** the developer's `src/greet.test.ts` contains
EXACTLY 5 tests — one per `examples` entry the architect put in
memory. Direct evidence the developer read the spec from memory and
turned each example into a test case. This is end-to-end proof that:

1. The MCP config JSON is generated and accepted by claude
2. The agent-harness-memory stdio server boots in the subprocess
3. memory.set persists to the per-run SQLite DB
4. memory.get retrieves across tasks (different worktrees, different
   subprocesses) within the same run
5. Multiple keys can coexist (arch.spec + dev.notes)

## Diagnosis surfaced before success

**First r4 run** (run `3033b9fa`, before fix): all three tasks
completed successfully and verify gates passed, BUT the kv table was
EMPTY after the run. No memory.set/get calls had reached the server
even though the agents claimed in their text output to have used
them.

Root cause: claude exposes MCP tools as `mcp__<server>__<tool>` with
dots in the tool name converted to underscores. So our `memory.set`
tool registered in `tools.ts` becomes
`mcp__agent-harness-memory__memory_set` from the agent's
perspective. The default team allowedTools whitelisted `memory.set`
verbatim, which silently matched nothing. Agents saw the tools in
their toolbox listing but were blocked from calling them.

A 30-second probe with `claude -p --mcp-config ... --allowedTools
mcp__agent-harness-memory__memory_set` confirmed the convention:
calling the fully-qualified name returns `{ok: true}` and the kv
row appears.

**Foundation patch** (commit `07e384c`): updated default team
allowedTools in `apps/dashboard-web/src/data/defaultTeam.ts` across
all three roles to the fully-qualified MCP tool names. Updated
prompt sentences and `docs/memory-mcp.md` to document the naming
convention so future team configurations don't repeat the mistake.

## M3 capabilities validated

| M3 capability | Status |
|---|---|
| `MemoryStore` SQLite WAL backend | ✅ DB file present, 2 rows after run |
| `tools.ts` registry exposes 4 tools | ✅ MCP server lists 4 tools (probe + run) |
| `server.ts` stdio MCP server | ✅ spawned per task by claude `--mcp-config` |
| `writeMemoryMcpConfig` per-run JSON | ✅ correct structure on disk |
| `--mcp-config + --strict-mcp-config` flag | ✅ subprocess pool injects via `defaultMcpConfigPath` |
| Cross-task memory roundtrip | ✅ arch.spec written by architect, read by developer |
| `.delete` not in defaults (footgun guard) | ✅ confirmed via dump |
| Compliance test sees memory-mcp src | ✅ globs include `packages/memory-mcp/src` |
| Naming convention `mcp__<server>__<tool>` | ✅ now documented + reflected in defaults |

---

# v1.0 Stage 4 — team templates (2026-05-05)

Branch `v1.0/m4-templates`, commits `7c77c7e..367ae32`.

## v1.0 ts-library template real-Claude run (M4 acceptance)

**Goal:** the first `suggestedGoals` entry from the built-in `ts-library`
template, picked verbatim: "Add a hello(name) function returning
'Hello <name>!' to src/hello.ts plus a Vitest test covering happy
path and empty-string edge case."

Four-role team from `ts-library` template (architect=opus,
core-dev=sonnet, test-dev=sonnet, qa=sonnet). Fresh repo `harness-r5`,
port 4507, run id `0dc0678b-4390-4e3f-801c-8604c35d71a9`.

**Outcome:** ✅ `status=completed, outcome=success`. Result branch
`harness/0dc0678b-4390-4e3f-801c-8604c35d71a9/result` carries:
`architecture.md`, `tasks.md`, `package.json`, `tsconfig.json`,
`src/hello.ts`, `src/hello.test.ts`. Every task done first-attempt.

`src/hello.ts`:
```ts
export function hello(name: string): string {
  return `Hello ${name}!`;
}
```

`src/hello.test.ts`:
```ts
describe('hello', () => {
  it('returns a greeting for a given name', () => {
    expect(hello('World')).toBe('Hello World!');
  });
  it('returns "Hello !" for an empty string', () => {
    expect(hello('')).toBe('Hello !');
  });
});
```

| Task | Role | Model | Tokens in | Tokens out | Turns | Duration |
|---|---|---|---|---|---|---|
| arch-1 | architect | opus | 38 294 | 3 687 | 15 | 104.6 s |
| core-1 | core-dev | sonnet | 28 424 | 8 032 | 28 | 190.7 s |
| test-1 | test-dev | sonnet | 8 767 | 3 131 | 18 | 91.4 s |
| qa-1 | qa | sonnet | 17 589 | 6 040 | 26 | 209.6 s |
| **total** | — | — | **93 074** | **20 890** | **87** | **596.2 s wall** |

The mixed-model run is the first time we've seen opus + 3×sonnet
together in the harness. Cost roughly an order of magnitude more than
all-haiku runs but produced cleaner first-attempt verify passes
across every gate.

## Memory MCP usage from the template's system prompts

The ts-library template's architect prompt mentions three keys:
`arch.contract`, `arch.spec`, `arch.tests`. The memory DB after the
run contains exactly those keys:

```
keys: 3
  arch.contract (size=171)  export function hello(name: string): string — returns `Hello ${name}!`...
  arch.spec     (size=280)  Small TypeScript library exposing a pure function...
  arch.tests    (size=155)  Vitest cases in src/hello.test.ts: (1) happy path — expect(hello('World'))...
```

Direct evidence the template's role prompts steered the architect
into the memory MCP correctly, and downstream roles read from it
(otherwise the test cases wouldn't match arch.tests verbatim).

## Diagnosis surfaced before success

**First boot of r5 server failed at startup** with:
```
Error: ENOENT: no such file or directory, open
'C:\...\dashboard-server\dist\templates\ts-library.json'
```

Root cause: Task 4.1's loader uses `readFileSync(import.meta.url + 'ts-library.json')`. The 4 template JSONs live in
`src/templates/` but `tsc -b` only emits `.js`/`.d.ts` — non-TS
files don't get copied to `dist/`. Vitest tests pass because they
load from `src/` directly; the production server runs from `dist/`
and crashes.

**Foundation patch** (commit `367ae32`):
`apps/dashboard-server/scripts/copy-templates.mjs` ferries every
`*.json` in `src/templates/` to `dist/templates/`. The `build`
script now runs `tsc -b && node scripts/copy-templates.mjs`. Server
boots cleanly thereafter.

## M4 capabilities validated

| M4 capability | Status |
|---|---|
| Built-in templates load + validate at boot | ✅ four built-ins, kebab-case unique ids |
| `GET /api/team-templates` merges built-ins + on-disk | ✅ 4 templates returned, sorted |
| Template's team round-trips through PUT /team | ✅ 4 roles persisted as configured |
| Template's `suggestedGoals[0]` works as a real-Claude goal | ✅ planner + walker produced exact match |
| Memory MCP roles in template invoke `arch.*` keys correctly | ✅ 3 memory keys present after run |
| New `copy-templates.mjs` build step | ✅ 4 JSON files in dist after build |
