-- v1.9.0 — Phase 0/2 foundation: plans.kind + plans.parent_state_id.
--
-- Plans today are a flat list — every run requires a fresh "initial" plan
-- and the planner has no formal signal that this is a follow-up run on an
-- already-working codebase. v1.9 introduces `plans.kind`:
--
--   - 'initial'   — first plan for a project; greenfield assumption ok.
--   - 'iteration' — user clicked "Run Iteration" after reviewing preview /
--                   visual-edit change-requests. Planner is REQUIRED to
--                   consume project-state.md and pending change_requests.
--                   Plans tend to be smaller, surgical.
--   - 'hardening' — auto-spawned by self-healing chain on remaining
--                   HIGH/CRITICAL findings.
--
-- `parent_state_id` links iteration plans to the project_state row they
-- were planned against, so we can debug "what did the planner think the
-- project looked like when it built this plan". NULL for initial plans
-- (there is no prior state) and optional for hardening plans.

ALTER TABLE `plans` ADD COLUMN `kind` text NOT NULL DEFAULT 'initial';--> statement-breakpoint
ALTER TABLE `plans` ADD COLUMN `parent_state_id` text REFERENCES `project_states`(`id`) ON DELETE SET NULL;
