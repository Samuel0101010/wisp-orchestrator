-- v1.9.0 — Phase 0/4 foundation: change_requests.
--
-- Holds visual-edit and text-mode change-requests captured from the Preview
-- tab. Each row is one user-authored "change this region" or "add this
-- feature" note. Rows stay 'pending' until the user clicks "Run Iteration",
-- at which point a new run is created with `kind='iteration'` and the
-- relevant change_request rows are linked via run_id and flipped to
-- 'in-run'. After the run completes the iteration-planner / runtime-verifier
-- marks them 'done' (matched) or 'dismissed' (user explicitly dropped from
-- queue).
--
-- `source` distinguishes between requests captured by clicking a region in
-- the preview iframe (visual) and plain-text "please add X" prompts the
-- user typed without a selector. `selector` and `rect` are NULL for text
-- requests. `screenshot_path` points at a PNG under <dataDir>/screenshots/
-- so the agent can see what the user clicked on.

CREATE TABLE `change_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
  `run_id` text REFERENCES `runs`(`id`) ON DELETE SET NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `source` text NOT NULL,
  `selector` text,
  `rect_json` text,
  `screenshot_path` text,
  `user_prompt` text NOT NULL,
  `created_at` integer NOT NULL,
  `resolved_at` integer
);--> statement-breakpoint
CREATE INDEX `change_requests_project_idx` ON `change_requests`(`project_id`);--> statement-breakpoint
CREATE INDEX `change_requests_status_idx` ON `change_requests`(`status`);
