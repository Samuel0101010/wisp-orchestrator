-- Project-level defaults for autopilot.
--
-- Until now autopilot was a per-run flag — every new run started with
-- autopilotMode=false because the runs table got a fresh row. Users (rightly)
-- expected "I enabled autopilot for my project" to persist.
--
-- This migration adds three project-level columns that startRun copies into
-- each new run row at insert time. Per-run overrides on the Run page still
-- work (POST /api/runs/:id/autopilot writes the run row directly), so
-- power-users keep the fine-grained control.
ALTER TABLE `projects` ADD COLUMN `default_autopilot_mode` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `default_autopilot_budget_minutes` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `default_autopilot_budget_tokens` integer;
