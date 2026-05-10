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
