-- v2.0.27 (migration 0019) — plans.created_at for correct recency ordering.
--
-- Plans are selected as "the latest plan" for a project by ordering on the
-- primary key, but the PK is a random UUIDv4 (randomUUID()) with no time
-- component. `ORDER BY id DESC` therefore returns the lexicographically
-- largest UUID, NOT the most recently created plan — wrong ~50% of the time
-- once a project has 2+ plans (the iteration / replan / self-healing flows
-- all create follow-up plans). This bit three call sites: the GET
-- /api/projects/:id/plan read, the chat `start_run` directive's latest-plan
-- lookup, and the org-chart latest-plan selection.
--
-- `created_at` is the authoritative recency key. Existing rows backfill to 0
-- (epoch) so that ANY plan created after this migration — which gets a real
-- millisecond timestamp via the app-level $defaultFn — correctly outranks
-- every pre-existing plan. Pre-existing plans tie at 0 and fall back to the
-- id tiebreaker, preserving today's (arbitrary but stable) ordering for
-- historical multi-plan projects with no behavioural regression.

ALTER TABLE `plans` ADD COLUMN `created_at` integer NOT NULL DEFAULT 0;
