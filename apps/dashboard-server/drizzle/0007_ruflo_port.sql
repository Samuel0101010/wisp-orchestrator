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
