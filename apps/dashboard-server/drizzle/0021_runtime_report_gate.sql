-- v2.6.1 (migration 0021) — persist the release-gate decision per runtime report.
--
-- `verdict` stays the VERIFIER's own verdict; the harness's auto-merge gate
-- can still hold the code back afterwards (unevidenced DoD criteria, open
-- findings). Until now that decision lived only in a run-log text event, so
-- the dashboard showed a READY-looking report while main never received the
-- merge. Both columns are nullable — rows from earlier runs have no gate
-- snapshot.
--   gate_verdict  'ready' | 'blocked' | 'manual-review'
--   gate_reasons  JSON array of human-readable reason strings

ALTER TABLE `runtime_reports` ADD COLUMN `gate_verdict` text;--> statement-breakpoint
ALTER TABLE `runtime_reports` ADD COLUMN `gate_reasons` text;
