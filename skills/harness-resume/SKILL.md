---
name: harness-resume
description: Use when the user wants to resume a previously paused WISP run (e.g. paused by rate-limit, by /pause, or by an earlier shutdown). Lists resumable runs and resumes a chosen one. Trigger on phrases like "resume my run", "continue the harness", "pick up where we left off".
---

# WISP — Resume Run

Resume a paused harness run.

## Preflight

Health-check the server: `curl -s http://127.0.0.1:${HARNESS_PORT:-4400}/api/health`. Bail with a friendly error if not 200 — tell the user to run `/harness-dashboard` first.

## Steps

1. **List resumable runs**:
   ```bash
   curl -s "http://127.0.0.1:${HARNESS_PORT:-4400}/api/runs?resumable=true"
   ```
   Response: `{"runs": [{"id":"...", "planId":"...", "status":"paused", "pausedReason":"...", "resumeAt": ..., ...}]}`.

2. **If 0 resumable runs**: tell the user there's nothing to resume and stop.

3. **If 1 resumable run**: confirm with the user briefly (one sentence summarising the run), then proceed to step 5.

4. **If 2+ resumable runs**: list them with id, paused-reason, and (if present) resumeAt. Ask the user which one to resume.

5. **Resume the chosen run**:
   ```bash
   curl -s -X POST "http://127.0.0.1:${HARNESS_PORT:-4400}/api/runs/<runId>/resume"
   ```
   The response includes the resumed status. Print the run URL:
   ```
   http://127.0.0.1:${HARNESS_PORT:-4400}/projects/<projectId>/run/<runId>
   ```

## Errors

- `409` Conflict from /resume → the run is no longer paused (raced with another resume / completed in the meantime). Re-list and try again.
- `503` from /resume → auth probe failed; tell the user to run `claude login`.

## Notes

- The `?resumable=true` filter only surfaces runs that need an explicit resume action: shutdown-recovered runs (status='paused', pausedReason='shutdown') and abrupt-crash runs (status='running' with a stale heartbeat that the server rewrote on boot). Rate-limit pauses auto-resume when their `resumeAt` timer fires and only show up here AFTER a server restart that rewrites them to 'shutdown'.
- A consecutive-failure pause and a manual /pause are NOT in this list during the same server lifetime — they live in `GET /api/runs?status=paused`. Use that endpoint when the user wants to resume one of those instead.
- A rate-limit-paused run can be resumed BEFORE its `resumeAt` window if the user wants to test (it'll just hit the rate-limit again, but that's their call).
