-- v2.0.0 — Phase 8: lead agent notes.
--
-- Each row is one synthesis from the lead agent (Theo) capturing the
-- project's situation at a moment in time + routing decisions. Notes are
-- created by POST /api/projects/:id/lead/tick (manual trigger in V1).
-- A future release can wire automatic ticks into the walker between tasks.
--
-- `summary_md` is the full agent-authored note (markdown), `decisions_json`
-- is a structured short-form ({ nextRole, reasoning, blockers[] }) for the
-- dashboard's at-a-glance lead card. `triggered_run_id` is set when the
-- lead decided to spawn a follow-up run (V1 leaves this null; the field is
-- here so we don't need another migration when we add auto-spawn).

CREATE TABLE `lead_notes` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
  `run_id` text,
  `summary_md` text NOT NULL,
  `decisions_json` text,
  `triggered_run_id` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lead_notes_project_idx` ON `lead_notes`(`project_id`);
--> statement-breakpoint
CREATE INDEX `lead_notes_created_idx` ON `lead_notes`(`created_at`);
--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `lead_enabled` integer NOT NULL DEFAULT 0;
