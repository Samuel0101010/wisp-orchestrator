-- Hardening: events queries by run_id (with ts ordering) were doing full table
-- scans on every dashboard poll and on every /api/runs/:id/events request.
-- Add a composite index covering both the equality filter and the sort.
CREATE INDEX IF NOT EXISTS events_run_id_ts ON events (run_id, ts DESC);
