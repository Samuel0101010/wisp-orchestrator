-- v1.9.0 — Phase 0/2 foundation: project_states.
--
-- After every successful run the runtime-verifier (or future lead agent)
-- writes a docs/project-state.md inside the managed repo summarising what
-- the project actually does today: implemented features, open todos, known
-- issues, and a thin architecture snapshot (top-level file map). We persist
-- one row per state-snapshot here so iteration planners can read the most
-- recent state without re-parsing markdown and so the UI can render a
-- "where the project stands" card.
--
-- `state_md` is the relative path to project-state.md in the managed repo
-- at the time of the snapshot. `completed_features`, `open_todos`, and
-- `known_issues` are JSON arrays of short strings the verifier extracted
-- (one bullet per entry). `architecture_snapshot` is a compact JSON
-- structure describing the top-level layout (folders, key files).

CREATE TABLE `project_states` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
  `run_id` text REFERENCES `runs`(`id`) ON DELETE SET NULL,
  `state_md` text,
  `completed_features` text NOT NULL DEFAULT '[]',
  `open_todos` text NOT NULL DEFAULT '[]',
  `known_issues` text NOT NULL DEFAULT '[]',
  `architecture_snapshot` text,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `project_states_project_idx` ON `project_states`(`project_id`);--> statement-breakpoint
CREATE INDEX `project_states_run_idx` ON `project_states`(`run_id`);
