ALTER TABLE `runs` ADD COLUMN `checkout_token` text;
--> statement-breakpoint
CREATE TABLE `prompt_bundles` (
	`bundle_key` text PRIMARY KEY NOT NULL,
	`cwd` text NOT NULL,
	`claude_session_id` text,
	`system_prompt_hash` text NOT NULL,
	`allowed_tools_hash` text NOT NULL,
	`model` text NOT NULL,
	`hit_count` integer NOT NULL DEFAULT 0,
	`last_used_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `prompt_bundles_last_used_idx` ON `prompt_bundles` (`last_used_at`);
--> statement-breakpoint
CREATE TABLE `run_summaries` (
	`run_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`summary_md` text NOT NULL,
	`mode` text,
	`tokens_total` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_summaries_project_idx` ON `run_summaries` (`project_id`,`created_at`);
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `error_reason` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `retry_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `next_retry_at` integer;
--> statement-breakpoint
CREATE INDEX `runs_error_reason_idx` ON `runs` (`error_reason`,`next_retry_at`);
