-- v1.9.0 — Phase 0/1 foundation: project_briefs.
--
-- Today the planner receives a single `goal` string and guesses everything
-- else (target audience, design preferences, NFRs, deadlines, ...). That is
-- the root cause of "fertig" lies — the plan was built on assumptions, not
-- elicited facts. This table backs the v1.9 interview-agent flow: a
-- requirements-interviewer Q&A's the user until the brief is "complete
-- enough", then `prd_path` points at docs/PRD.md inside the managed repo
-- and the planner consumes the brief as additionalContext.
--
-- Fields are all optional except project_id + completeness_score so the row
-- can be inserted at project-create time and filled in as the interview
-- progresses. `completeness_score` is the interviewer's self-estimate (0–100)
-- so the UI can show progress and the planner can gate.

CREATE TABLE `project_briefs` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
  `target_audience` text,
  `success_criteria` text,
  `design_prefs` text,
  `platform` text,
  `constraints` text,
  `deadline` integer,
  `completeness_score` integer NOT NULL DEFAULT 0,
  `prd_path` text,
  `brief_ready` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `project_briefs_project_idx` ON `project_briefs`(`project_id`);
