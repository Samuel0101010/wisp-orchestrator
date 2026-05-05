PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`task_id` text,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`ts` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_events`("id", "run_id", "task_id", "type", "payload", "ts") SELECT "id", "run_id", "task_id", "type", "payload", "ts" FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text NOT NULL,
	`plan_id` text NOT NULL,
	`role` text NOT NULL,
	`title` text NOT NULL,
	`deps` text NOT NULL,
	`status` text NOT NULL,
	`worktree_branch` text,
	`session_id` text,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`turns_used` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`plan_id`, `id`),
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "plan_id", "role", "title", "deps", "status", "worktree_branch", "session_id", "tokens_in", "tokens_out", "turns_used", "duration_ms") SELECT "id", "plan_id", "role", "title", "deps", "status", "worktree_branch", "session_id", "tokens_in", "tokens_out", "turns_used", "duration_ms" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;