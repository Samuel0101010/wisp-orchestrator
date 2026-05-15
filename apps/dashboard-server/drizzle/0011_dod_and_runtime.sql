-- v1.8.0 — Definition of Done + Runtime Verification.
--
-- The harness previously claimed "done" when static checks (build, typecheck,
-- unit tests) were green. That misses an entire class of bugs that only show
-- up when the app actually boots and a user clicks around: broken routes,
-- missing env vars, dead React effects, 500s from API calls.
--
-- This migration introduces two persistence concepts:
--
-- 1. `dod_criteria` — per-project list of acceptance criteria the user
--    declares as the bar for "fertig". Each criterion has a `kind`:
--      - 'smoke': "GET <url> returns 200 within Xs after `pnpm dev` starts"
--      - 'e2e':   "Playwright test <id> passes"
--      - 'manual': "user clicks through and approves" (display-only,
--                  never auto-pass — it always blocks release until a human
--                  marks it verified)
--    `spec_json` carries kind-specific config (url, expected status, test
--    file path, etc).
--
-- 2. `runtime_reports` — per-run record of what the runtime-verifier
--    agent produced: boot-smoke verdict, Playwright result, list of DoD
--    criteria evidenced, raw markdown report. One row per (run, verifier
--    iteration). The post-success hook reads the latest row to decide
--    whether the run is releasable.
--
-- Project-level toggles on `projects` control whether runtime-verify runs
-- at all (default ON for v1.8 — explicit "no" requires the user to flip it
-- off in the dashboard). When a project has no `runtime_verify_dev_cmd`
-- and detect-project-type can't infer one, the boot-smoke step degrades
-- to a CRITICAL finding so the agent knows it has to wire one up.

CREATE TABLE `dod_criteria` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
  `title` text NOT NULL,
  `kind` text NOT NULL,
  `spec_json` text NOT NULL,
  `position` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `dod_criteria_project_idx` ON `dod_criteria`(`project_id`);--> statement-breakpoint

CREATE TABLE `runtime_reports` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL REFERENCES `runs`(`id`) ON DELETE CASCADE,
  `verdict` text NOT NULL,
  `boot_ok` integer NOT NULL DEFAULT 0,
  `e2e_ok` integer NOT NULL DEFAULT 0,
  `dod_passed` integer NOT NULL DEFAULT 0,
  `dod_total` integer NOT NULL DEFAULT 0,
  `report_md` text,
  `evidence_json` text,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `runtime_reports_run_idx` ON `runtime_reports`(`run_id`);--> statement-breakpoint

-- Project-level runtime-verify config. `runtime_verify_dev_cmd` and
-- `runtime_verify_probe_url` may be NULL — boot-smoke then falls back to
-- detect-project-type heuristics (vite → `pnpm dev` + http://localhost:5173,
-- next → `pnpm dev` + http://localhost:3000, fastify/express → `pnpm start`
-- + http://localhost:<PORT-or-3000>/health).
ALTER TABLE `projects` ADD COLUMN `runtime_verify_enabled` integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `runtime_verify_dev_cmd` text;--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `runtime_verify_probe_url` text;
