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
--> statement-breakpoint
CREATE TABLE `model_router_priors` (
	`role` text NOT NULL,
	`model` text NOT NULL,
	`alpha` real NOT NULL DEFAULT 1,
	`beta` real NOT NULL DEFAULT 1,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`role`, `model`)
);
--> statement-breakpoint
CREATE TABLE `model_router_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`model` text NOT NULL,
	`taken_at` integer NOT NULL,
	`outcome` text,
	`recorded_at` integer
);
--> statement-breakpoint
CREATE INDEX `model_router_samples_pending_idx` ON `model_router_samples` (`outcome`);
--> statement-breakpoint
CREATE TABLE `trajectories` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text REFERENCES `projects`(`id`) ON DELETE cascade,
	`prompt` text NOT NULL,
	`plan_json` text NOT NULL,
	`outcome` text NOT NULL,
	`terms_json` text NOT NULL,
	`lessons` text,
	`tokens_total` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trajectories_project_idx` ON `trajectories` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `hook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`tool_name` text,
	`cwd` text,
	`payload_json` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hook_events_event_idx` ON `hook_events` (`event`,`received_at`);
