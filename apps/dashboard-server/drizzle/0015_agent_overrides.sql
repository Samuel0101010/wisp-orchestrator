-- v1.9.0 — Phase 0/5+6 foundation: project_agent_overrides.
--
-- Each project gets its own team (the rows in `teams.rolesJson`), but the
-- *system prompts* for each role currently come from the shared agent
-- definitions in /agents/*.md. v1.9 introduces per-project customisation:
-- the user can append a project-specific instruction to a role's system
-- prompt, swap the model, widen the allowed-tools list, or assign a
-- dedicated memory-namespace ("this developer remembers things only for
-- this project"). Overrides are additive — base prompt + override tail —
-- so removing the override row falls back to the default.
--
-- One row per (project, role). Composite uniqueness enforced via index.
-- All fields except project_id/role are nullable; an "override" with all
-- fields NULL is meaningless and should not be inserted (no SQL-level
-- constraint, callers enforce).

CREATE TABLE `project_agent_overrides` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
  `role` text NOT NULL,
  `model` text,
  `extra_system_prompt` text,
  `extra_allowed_tools` text,
  `memory_namespace` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `project_agent_overrides_project_role_idx`
  ON `project_agent_overrides`(`project_id`, `role`);
