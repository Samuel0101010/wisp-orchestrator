# Authentication modes

## Overview

WISP supports two authentication modes for agent runs:

1. **Subscription mode** (default) — uses the local `claude` CLI which
   authenticates against the user's Claude account (Pro, Max, or Team).
2. **API mode** — uses `ANTHROPIC_API_KEY` directly via the Anthropic SDK.

The mode is selected at server start via the `WISP_AUTH_MODE` environment
variable (`subscription` or `api`; default `subscription`).

| Aspect       | Subscription                    | API                                     |
| ------------ | ------------------------------- | --------------------------------------- |
| Cost model   | Flat subscription               | Per-token                               |
| Daily limits | Per Claude plan                 | Higher / pay-as-you-go                  |
| Setup        | Existing `claude login`         | `ANTHROPIC_API_KEY` env var             |
| Best for     | Solo dev, frequent short runs   | Heavy use, CI, evals                    |
| Latency      | Same                            | Same (slightly less probe overhead)     |

## When to use Subscription mode

- You already have Claude Max (or Pro / Team).
- You want predictable monthly cost.
- Most exploratory work — this is the default and the path WISP was tuned for
  (subscription-friendly pacing defaults like `WISP_INTER_TASK_PACING_MS=5000`).

## When to use API mode

- Your daily run volume exceeds the value of a Claude Max seat (roughly 8+ hours
  of active agents per day).
- You need to integrate with CI or scheduled runs where no interactive
  `claude login` is available.
- You want larger context windows or parallel ops where subscription
  rate-limits become a bottleneck.
- Evals / benchmarking where billing per token gives precise cost-tracking.

## How to switch

```sh
# Subscription (default) — no env vars required
unset WISP_AUTH_MODE
unset ANTHROPIC_API_KEY    # optional, prevents accidental API mode

# API
export WISP_AUTH_MODE=api
export ANTHROPIC_API_KEY=sk-ant-...
```

On Windows (PowerShell):

```powershell
# Subscription
Remove-Item Env:WISP_AUTH_MODE -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

# API
$env:WISP_AUTH_MODE = 'api'
$env:ANTHROPIC_API_KEY = 'sk-ant-...'
```

Restart the WISP server after changing mode — the value is read once at
startup.

Note: agent subprocesses always inherit your local `~/.claude/` credentials,
so even in API mode the spawned `claude` CLI can fall back to its own session
if the SDK call path is bypassed.

## Cost estimation

Rough ballparks for API mode (Sonnet 4.6, May 2026 pricing):

- A "small" goal (e.g. "add a unit test"): **$0.05 – $0.20**
- A "medium" goal (e.g. "implement REST CRUD with tests"): **$0.30 – $1.50**
- A "large" multi-phase refactor: **$3 – $15** — set a budget via
  Settings → Cost limits before kicking it off.

Subscription mode: **$0 marginal cost per goal** (within plan limits).

## ToS notes

- **Subscription mode** — usage is subject to the Claude Code terms (including
  usage limits and fair-use). See <https://www.anthropic.com/legal/aup>.
- **API mode** — standard Anthropic API ToS:
  <https://www.anthropic.com/legal/api-terms>.
- WISP does **not** relay credentials anywhere; all model calls go from your
  machine directly to Anthropic. There is no telemetry endpoint.

See also: [docs/anthropic-compliance.md](anthropic-compliance.md) for the
compliance posture (pacing defaults, parallelism caps, audit-test list).

## Hybrid mode (advanced)

The orchestrator currently uses a single auth mode per server start. If you
need mixed runs (e.g. subscription for exploration + API for evals), spin up
a second server on a different port with the alternate mode and a separate
`WISP_DATA_DIR`:

```sh
WISP_PORT=4500 \
WISP_DATA_DIR=/path/to/api-data \
WISP_AUTH_MODE=api \
ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --filter @wisp/dashboard-server start
```

Each server has its own DB, worktrees, and run history — they do not share
state.
