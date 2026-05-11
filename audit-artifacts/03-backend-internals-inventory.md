# Backend Internals Inventory & Audit — Agent Harness

**Date:** 2026-05-11
**Scope:** workers, skills, manager/agents, schema, orchestrator

---

## 1. Workers

Registered in `apps/dashboard-server/src/routes/index.ts` (lines 38-85). Executed by `WorkerDaemon`.

| Worker | Cron | Enabled | Handler | Notes |
|--------|------|---------|---------|-------|
| audit-orphan-runs | `*/30 * * * *` | ✓ | `auditOrphanRuns()` | Flags runs running >2h with no events |
| auto-doc | `0 * * * *` | ✓ | `autoDoc()` | Audit-only: lists candidates; never creates docs |
| **consolidate-memory** | `0 3 * * *` | ✗ | **NO-OP** | Always returns `{note: 'no-op until memory-mcp dedupe API exists'}` |
| inventory-refresh | `0 6 * * *` | ✓ | `inventoryRefresh()` | Runs `scripts/inventory.mjs` |
| autopilot-tick | `* * * * *` | ✓ | `tickAutopilot()` | Resume paused autopilot runs |
| prompt-bundle-evict | `0 4 * * *` | ✓ | `promptBundleEvict()` | 7d TTL eviction |
| run-summary-fallback | `*/15 * * * *` | ✓ | `runSummaryFallback()` | Catches missed summary hooks |
| retry-max-turns | `*/2 * * * *` | ✓ | `retryMaxTurns()` | 4-attempt graduated retry |

Manual-run endpoint: `POST /api/workers/:name/run`. All wrapped in `WorkerRegistry.runNow()` with error capture.

---

## 2. Skills

### Seed skills (5)
Location: `apps/dashboard-server/src/skills/seed/`.

| Skill | Model | Allowed Tools |
|-------|-------|---------------|
| audit-orphan-runs | haiku | Bash, Read |
| auto-doc | sonnet | Read, Write, Bash |
| deep-research | sonnet | Read, Grep, Glob, WebFetch |
| doctor | haiku | Bash, Read |
| summarize-thread | haiku | (none) |

### Multi-source discovery
`discoverSkills()` in `skills/discovery.ts` loads in order (first-wins):
1. seed (built-in)
2. project (`$HARNESS_PROJECT_ROOT/.claude/skills`)
3. user (`~/.claude/skills`)
4. plugin (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/`)

### Registry init
`SkillRegistry` constructor supports:
- Legacy: `new SkillRegistry(rootDir)` — single root
- Explicit list: `{ skills: [...] }` (tests)
- Discovery: `{ discoveryOpts: {...} }` (prod)

---

## 3. Manager & Agents

10 seed agents in `db/agents-seed.ts` (Marcus, Lena, Diego, Aiko, Sven, Priya, Maya, Elena, Javier, Noah). Manager (Marcus) emits directives wrapped in `<<ACTION>>{...}<<END>>`.

### Directives (5)
| Directive | Handler |
|-----------|---------|
| consult | `handleConsult()` |
| add_member | `handleAddMember()` |
| create_project | `handleCreateProject()` |
| start_run | `handleStartRun()` |
| invoke_skill | `handleInvokeSkill()` |

Cap: `MAX_DIRECTIVES_PER_TURN = 4`.

---

## 4. Schema & Migrations

9 migrations (`0000_*.sql` through `0008_paperclip_port.sql`). 17 tables.

### Tables
projects, teams, plans, tasks, runs, events, checkpoints, agents, agent_threads, agent_messages, thread_participants, chat_actions, worker_runs, model_router_priors, model_router_samples, trajectories, hook_events, prompt_bundles, run_summaries, rate_windows.

---

## 5. Orchestrator (`packages/orchestrator/src/`)

- **Walker (1196 LOC)** — DAG execution engine; topology + budgets + worktree lifecycle + events.
- **Subprocess (449 LOC)** — Spawn `claude -p`; strip `ANTHROPIC_API_KEY`; NDJSON parse; stderr rate-limit detection.
- **Pool (149 LOC)** — Concurrency limiter for subprocess slots.

---

## 6. Issues found

### Critical (blocking quality)
1. **consolidate-memory is a no-op stub** — should be removed or documented; currently dead code.
2. **worker_runs grows unbounded** — no TTL/GC, will bloat DB over time.

### High
3. **skills-discovery overly strict frontmatter** — rejects valid SKILL.md files that lack `model` or `allowed-tools` (most user/plugin skills fail). Server logs ~50 skip lines per boot.
4. **Migration 0008 documentation** — `ALTER TABLE runs ADD COLUMN error_reason text;` is safe (nullable), but the file should comment why no DEFAULT.

### Medium
5. **task_id in events has no FK** — free-form string field; could be validated at app layer or simply documented as audit-only.
6. **Manager system prompt rebuilt every chat message** — `buildManagerSystemPrompt()` could be cached.
7. **Rate-limit detection is English-only regex** — `/max[- ]turns?\s*(exceeded|reached|exhausted)/i`.

### Low
8. **Auto-doc worker should be renamed `audit-missing-docs`** — actual behavior is audit-only, not creation.
9. **Type alias collisions** — `Agent`, `Plan`, `Team` imported from Drizzle schemas conflict with Zod types in some files; should standardize on `*Row` suffix.

---

## Top 10 internal fixes (ranked)

1. **Relax skills-discovery frontmatter** — accept skills with just `name` + `description`; default model to `sonnet`, default allowed-tools to `[]`. Unlocks ~40 plugin skills the user already installed.
2. **Add worker-runs GC** — new worker `worker-runs-prune` with `0 5 * * 0` cron, 30-day retention.
3. **Remove or document consolidate-memory** — currently disabled no-op; either delete or add comment.
4. **Skills-discovery quiet mode** — change skip-logs from `console.warn` to `log.debug` (drowns out server boot output).
5. **Plumb errorReason through chat.ts:404** — replace fragile regex with explicit Drizzle constraint error detection.
6. **Log silent JSON.parse failures in agents.ts** — currently swallowed; should log to console.error.
7. **Insights.ts:50 — replace unsafe cast with parseSafe helper** — return `null` + log on fail.
8. **Prompt-bundles delete returns 204** — currently implicit 200.
9. **Cache manager system prompt** — rebuild only when agents/skills changed.
10. **Standardize Row-suffix type imports** — Agent → AgentRow, Plan → PlanRow, Team → TeamRow.
