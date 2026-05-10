-- Chat v2: multi-participant threads, agent identity on messages, manager
-- directive audit log, avatars + seed-key + kind on agents.

ALTER TABLE `agents` ADD COLUMN `avatar_url` text;
--> statement-breakpoint
ALTER TABLE `agents` ADD COLUMN `seed_key` text;
--> statement-breakpoint
ALTER TABLE `agents` ADD COLUMN `kind` text NOT NULL DEFAULT 'user';
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_seed_key_unique_idx` ON `agents` (`seed_key`) WHERE `seed_key` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_messages` ADD COLUMN `author_agent_id` text REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
CREATE INDEX `agent_messages_author_idx` ON `agent_messages` (`author_agent_id`);
--> statement-breakpoint
CREATE TABLE `thread_participants` (
	`thread_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`role` text NOT NULL DEFAULT 'member',
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `agent_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `agent_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_participants_thread_idx` ON `thread_participants` (`thread_id`);
--> statement-breakpoint
CREATE INDEX `thread_participants_agent_idx` ON `thread_participants` (`agent_id`);
--> statement-breakpoint
CREATE TABLE `chat_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`message_id` text,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`result_json` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `agent_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `agent_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `chat_actions_thread_idx` ON `chat_actions` (`thread_id`,`created_at`);
