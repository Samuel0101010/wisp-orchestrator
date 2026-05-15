-- v1.9.0 — Phase 0/7 foundation: projects.package_target + projects.artifact_path.
--
-- The harness ships managed projects as git branches today. v1.9 adds an
-- optional "package as native binary" step after the release-gate goes
-- ready: a `packager` agent scaffolds Tauri (default) or Electron, runs
-- `tauri build`, and stores the resulting installer under
-- <dataDir>/artifacts/<projectId>/<runId>/. The dashboard UI exposes a
-- "Build App" button when `package_target != 'web'` and no change_requests
-- are pending. The button enqueues a build-only run (no DAG, just the
-- packager task) which writes the final artifact path back to
-- projects.artifact_path so the UI can offer a Download link.
--
-- Default is 'web' (no packaging) to keep existing projects untouched. The
-- packager agent decides at scaffold-time whether the project's existing
-- structure is compatible with Tauri (Vite/Next/etc) and surfaces a finding
-- if not.

ALTER TABLE `projects` ADD COLUMN `package_target` text NOT NULL DEFAULT 'web';--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `artifact_path` text;
