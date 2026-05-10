CREATE TABLE `worker_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_name` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`status` text NOT NULL,
	`result_json` text,
	`error_reason` text
);
--> statement-breakpoint
CREATE INDEX `worker_runs_name_idx` ON `worker_runs` (`worker_name`,`started_at`);
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `autopilot_mode` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `autopilot_budget_minutes` integer;
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `autopilot_budget_tokens` integer;
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `autopilot_started_at` integer;
