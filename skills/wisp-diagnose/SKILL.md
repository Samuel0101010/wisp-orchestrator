---
name: wisp-diagnose
description: Use when a WISP run failed unexpectedly or is stuck — fetches the event timeline for a run, highlights failures, and prints the verify-failed payloads with full output so the user can see exactly why a task failed. Trigger on phrases like "why did the run fail", "diagnose the harness", "what went wrong with the run".
---

# WISP — Diagnose Run

Inspect a run's event timeline to figure out what failed and why.

## Inputs

- **runId**: the run UUID. Ask the user if not provided.

## Steps

1. **Fetch the events**:
   ```bash
   curl -s "http://127.0.0.1:${WISP_PORT:-4400}/api/runs/<runId>/events?limit=500"
   ```
   Response: `{"events": [{"type":"...", "payload":..., ...}, ...]}` ordered oldest-first.

2. **Show the timeline**, condensed: print one line per event of interest. Skip noisy types (`task.text-delta`, `task.usage` — print usage totals at the end instead). Format:
   ```
   <timestamp>  <event type>  <task id>  <one-line summary>
   ```

3. **Highlight failures**: for each `task.failed`, `harness.verify-failed`, `qa.replan-triggered`, `qa.replan-exhausted`, `rate-limit.hit`, `run.paused` event, print the FULL payload (not a one-liner). Especially:
   - `harness.verify-failed.payload.failures[*]` — kind, cmd, exitCode, tail
   - `harness.verify-failed.payload.output` — full output (truncate to last 100 lines if huge)
   - `qa.replan-triggered.payload.reason` — what QA reported

4. **Token & duration totals**: query `/api/runs/<runId>` to get the per-task token/turn totals. Print as a small table.

5. **Verdict**: in 1-2 sentences, summarise WHY the run failed (or what it's currently stuck on). Quote a specific event payload as evidence.

## Useful event types to know

| Type | Means |
|---|---|
| `task.started` | A task subprocess began |
| `task.completed` | The subprocess returned (regardless of verify result) |
| `harness.verify-failed` | The verify gate (build/test/lint/custom/preflight) rejected the task; full failures + output payload |
| `task.failed` | Terminal failure; subsequent dependent tasks were cancelled |
| `qa.replan-triggered` | M5 — QA failure caused the walker to swap in a new plan |
| `qa.replan-exhausted` | M5 — replan cap hit OR replan callback returned null |
| `rate-limit.hit` | A subprocess hit a Claude rate limit; usually followed by `run.paused` |
| `run.paused` | Walker paused (rate-limit / user / shutdown / consecutive-failures) |

## Notes

- Events are persisted to SQLite under `<WISP_DATA_DIR>/harness.db`. If the API is down, you can read them directly with sqlite3 from the harness.db.
- For runs that completed long ago, all event details are still in the DB — there's no retention policy.
