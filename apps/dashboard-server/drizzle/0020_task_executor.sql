-- v2.3 (migration 0020) — task executor identity columns.
--
-- The walker resolves the effective agent (team role + per-project override)
-- at dispatch time, but until now nothing persisted WHO actually ran a task:
-- the UI could only show the role string. These four columns snapshot the
-- executor identity when the task transitions to running:
--   executor_name         display name of the linked agents-registry row
--                         (NULL when the role has no agentId link)
--   executor_model        the model the subprocess was actually launched with
--   executor_model_stored the team's stored model when a per-project override
--                         swapped it (NULL when no swap happened)
--   executor_avatar_url   avatar of the linked agent, for the run timeline UI
-- All nullable — rows from runs before this migration simply have no identity.

ALTER TABLE `tasks` ADD COLUMN `executor_name` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `executor_model` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `executor_model_stored` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `executor_avatar_url` text;
