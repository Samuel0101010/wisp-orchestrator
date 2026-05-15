-- Stage 1+3: production loop columns.
--
-- projects gain three toggles that together turn a run into an
-- auto-iterating "make me a production-ready app" pipeline:
--   * auto_merge_on_success — after a successful run, fast-forward
--     (or non-ff fallback) the result branch into main so the user's
--     working tree has the finished code without a manual git merge.
--   * self_healing_enabled — after a successful run, scan the result
--     branch's docs/security-review.md + docs/qa-report.md for HIGH
--     or CRITICAL findings; if any remain AND chain_iteration is
--     under the cap, spawn a follow-up hardening run automatically.
--   * max_chain_iterations — hard ceiling on how many self-healing
--     follow-ups can chain (prevents runaway loops if an agent keeps
--     adding new findings every pass).
--
-- runs gain a back-pointer to the run that triggered this one
-- (parent_run_id) and a chain_iteration counter (0 for user-launched,
-- 1..N for self-healing follow-ups).
ALTER TABLE `projects` ADD COLUMN `auto_merge_on_success` integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `self_healing_enabled` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `max_chain_iterations` integer NOT NULL DEFAULT 3;--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `parent_run_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `chain_iteration` integer NOT NULL DEFAULT 0;
