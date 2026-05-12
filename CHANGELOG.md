# Changelog

## 1.6.0 — i18n + design tokens + tooltip coverage

Audit follow-up sweeping the three items deferred from v1.5.0: full i18n
migration of the five complex pages, ui-ux-pro-max design-token migration
with a primitive layer, and tooltip + a11y coverage on every interactive
button.

### Phase 1 — Tooltips + a11y

- New `IconButton` wrapper (`apps/dashboard-web/src/components/ui/icon-button.tsx`)
  combines Radix Tooltip + Button + required `aria-label` into one component
  — makes a11y the path of least resistance for icon-only triggers.
- Tooltips wired up on every icon button across Sidebar, TopBar, LanguageToggle,
  ThemeToggle, Chat (new-thread, send, add-member, remove-member), RunView
  (pause, resume, cancel, resume-now), TeamRoleCard (move-up, move-down,
  remove), PlanEditor (regenerate, lock & run).
- Fixed missing aria-label on `Chat.tsx` new-thread + send buttons,
  `Goap.tsx` textareas, and `AgentChat.tsx` agent-selector `<select>`.
- New e2e spec `tooltips.spec.ts` enforces every visible button has an
  accessible name on every page in both en + de.

### Phase 2 — i18n migration of 5 complex pages

- Migrated Chat (869 LOC), Home (407 LOC), RunView (870 LOC),
  TeamBuilder (443 LOC), PlanEditor (553 LOC) and their sub-components
  (AgentChat, Avatar, AvatarPicker, GlobalRunsTable, KpiTile,
  LiveNowGrid, OutcomeDonut, TokenAreaChart, TeamRoleCard,
  ApplyTemplateDialog, TeamJsonDialog, CostEstimatePanel, FirstRunModal,
  PlanCanvas, PlanVersionBadge, RunStore, AutopilotToggle, StatusDotBadge).
- ~180 new translation keys added to both `en/common.json` and
  `de/common.json` with top-level key parity enforced.
- Shared helpers in `apps/dashboard-web/src/lib/`:
  - `fmt-rel.ts` — `fmtRel(date, lang)` using `Intl.RelativeTimeFormat`
    for locale-aware "5 minutes ago" / "vor 5 Minuten".
  - `status-labels.ts` — `statusLabel(status, t)` maps status enum to
    translated label via the shared `status.*` namespace.
- `StatusDotBadge` now i18n-aware by default; every consumer gets
  translated status strings for free.

### Phase 3 — Design-token migration

- New `apps/dashboard-web/src/styles/tokens-primitive.css` — Layer 1
  raw values (color scales, spacing, type scale including `text-3xs`/`text-2xs`/
  `text-xs2`/`text-sm-tight` for the 9/10/11/13px sub-xs sizes that the
  dashboard's dense badges legitimately need, shadow scale, z-index scale,
  letter-spacing scale).
- New `apps/dashboard-web/src/styles/tokens-component.css` — Layer 3
  component-specific aliases (button, input, card, dialog).
- New Tailwind utilities wired through `@theme`: `text-3xs`, `text-2xs`,
  `text-xs2`, `text-sm-tight`, `tracking-widest`.
- All 82 arbitrary Tailwind values (`text-[Npx]`, `tracking-[…]`, etc.) eliminated.
- One hex literal (`#67e8f9` placeholder in Agents.tsx color dialog) moved
  to the i18n bundle as `agents.dialog.colorPlaceholder`.
- New `apps/dashboard-web/scripts/validate-tokens.cjs` validator + companion
  `validate-tokens.test.cjs` lock-down test caps the `h-[calc(…)]` allowlist
  size. Wired as `pnpm tokens:check` and into `.github/workflows/ci.yml`.
- WCAG-AA color-contrast token nudges to `--muted-foreground`, `--info`,
  `--warning-foreground` in both light and dark themes (most contrast pairs
  now pass AA; the remaining ones — `text-muted-foreground/60` and similar
  opacity-reduced variants — are deferred to v1.6.1 with a TODO in the
  a11y spec).

### Test infrastructure

- New `tests/e2e/helpers/`:
  - `set-lang.ts` — pre-seed `agent-harness-lang` in localStorage so the
    SPA boots straight into the chosen locale.
  - `locator-by-key.ts` — `tt(lang, key, vars?)` resolves dotted i18n
    keys against the on-disk bundle without going through a running app.
- `tests/e2e/playwright.config.ts` now runs every spec in two projects:
  `chromium-en` (locale `en-US`) and `chromium-de` (locale `de-DE`).
- New e2e specs: `a11y.spec.ts` (axe-core scan), `i18n.spec.ts` (per-page
  heading match), `tooltips.spec.ts` (every button has an accessible name).
- `pretest:e2e` rebuilds dashboard-web + dashboard-server before every
  local e2e run so tests never run against a stale bundle.
- Added `@axe-core/playwright` as a dev dep on the e2e package.

### Notable removals

- Local `fmtRel` stubs in `Chat.tsx`, `AgentChat.tsx`, `Agents.tsx` —
  replaced with the shared i18n-aware helper.

## 1.5.0 — Audit pass: backend hardening + UI primitives

Wall-to-wall audit of the harness. Focus was on correctness, observability,
and consistent UI primitives — not new features. ~9k LOC of dead prototype
code removed; one real production bug fixed (caught by a live manager-run
test).

### Fixed — runtime

- **MCP config path is now absolute** (`apps/dashboard-server/src/orchestrator/mcp-config.ts`,
  `runtime.ts`). The previous code read `process.env.HARNESS_DATA_DIR ?? '.'`
  directly, bypassing the Zod default in `env.ts`. When the env var was
  unset the per-run config landed at `./mcp-configs/<runId>.json` —
  relative to whatever cwd the server started in. Claude was then spawned
  from the task's worktree cwd and ENOENT'd on the path. Every fresh
  real run was failing on the first task. Switched all `HARNESS_DATA_DIR`
  reads to `env.HARNESS_DATA_DIR` (post-Zod default) and resolve
  `mcpConfigPath` to absolute up front. Snapshots dir + templates dir
  got the same treatment.
- **`worker-runs-prune` worker** (weekly, 30-day retention) prevents
  unbounded growth of the `worker_runs` table.

### Fixed — observability

- **`agents.ts` corruption-skip catches now log**. The three places that
  silently swallowed JSON.parse failures on a corrupt `teams.roles_json`
  now warn with the call-site context (`isReferenced`, `forceDelete`,
  `usage`). Same skip-on-fail behaviour at the call sites; the warning
  surfaces the data bug instead of hiding it.
- **`insights.ts:50` unsafe cast removed**. `JSON.parse(row.planJson as
  unknown as string)` — `planJson` is already typed `string` by Drizzle.
  Parse failures now log instead of silent fallback to `null`.
- **`prompt-bundles` DELETE returns 204** (was implicit 200 with body).
- **`insights/trajectories/:id` DELETE returns 204** (same).
- **rmSync failure in `prompt-bundles` DELETE is logged**.

### Fixed — skill discovery

- **Loader frontmatter requirement relaxed**: only `name` and
  `description` are required now; `model` defaults to `'sonnet'` and
  `allowed-tools` defaults to `[]`. Files without any frontmatter at
  all throw a typed `NotASkillError` so callers skip silently instead
  of warning. Result: ~30 plugin/user skills that were being skipped
  with a noisy warning at server boot (e.g. `chrome-devtools-mcp`,
  `superpowers`, `firecrawl`, `mcp-server-dev`) are now discovered.
  Concrete: 5 → 35 reachable skills on a representative dev machine.

### Added — UI primitives

- `Skeleton`, `SkeletonText`, `SkeletonRow` — animated bars to replace
  bare `"Loading…"` text everywhere.
- `EmptyState` — icon + title + body + action, used wherever a list
  was previously a bare `"No data"` line.
- `ErrorBanner` — inline error with retry, used as a fallback when a
  query rejects instead of silently rendering `?? []`.

### Changed — UI polish

- **Sidebar version badge is dynamic** — reads `__APP_VERSION__`
  injected at build time from `apps/dashboard-web/package.json`. No
  more stale hardcoded strings drifting across releases.
- **Sidebar nav labels are i18n** — Team Chat, Agents, Skills, Workers,
  Insights, GOAP Planner, Prompt Bundles all use translation keys.
- **Workers, Skills, PromptBundles, Insights, Goap, Agents** pages
  rewritten with the new primitives + tables wrapped in
  `overflow-x-auto` for mobile + full i18n on page chrome.
- All 23 dead `/mc/v1`–`/mc/v20` + 3 `/mc` compare prototype routes
  removed (~9k LOC). They were unlinked since v1.2.0 picked the
  chosen variant for Home; many had partial dark-mode coverage.

### Audit artifacts

`audit-artifacts/` carries the inventory reports (API routes, frontend,
backend internals) plus baseline screenshots of every page in dark and
light mode. Kept in-tree for the v1.5.0 PR.

## 1.4.0 — Multi-source skills + refreshed avatars

Two user-facing wins: the harness now uses **every** Claude Code skill you
already have (project-local, user-global, plugin-bundled), and the 10
seed-agent + 20 generic profile pictures got a clean new generation.

### Added — Multi-source skill discovery (#38)

- New `apps/dashboard-server/src/skills/discovery.ts` walks all four
  conventional Claude Code skill locations and merges them into one
  registry:
  1. Built-in seed (`apps/dashboard-server/src/skills/seed/`) — ships
     with the harness.
  2. Project-local (`<projectRoot>/.claude/skills/`).
  3. User-global (`~/.claude/skills/`).
  4. Plugin cache (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/`).
- Plugins with multiple cached versions side-by-side (e.g. `superpowers`
  5.0.7 + 5.1.0 + content-hash entries) contribute only their
  lexically-greatest version — a good-enough proxy for "newest".
- **First-loaded wins** on name collisions, processed in the priority
  order above so built-ins and project-scoped skills shadow user-global
  and plugin-bundled ones. Shadowed skills are tracked in
  `DiscoveryStats` for diagnostics but not exposed via the API.
- Each skill carries a `source` tag — `'seed' | 'project' | 'user' |
  'plugin:<name>'` — surfaced by `GET /api/skills`.
- `/skills` web route gains coloured per-source badges (blue=seed,
  emerald=project, amber=user, fuchsia=plugin) plus filter pills with
  live counts.
- `SkillRegistry` constructor accepts three init shapes:
  `rootDir: string` (back-compat), `{ skills: Skill[] }` (explicit
  list), `{ discoveryOpts }` (full multi-source discovery).
- Legacy `HARNESS_SKILLS_DIR` env var still works as a single-root
  escape hatch. New `HARNESS_PROJECT_ROOT` env var overrides
  `process.cwd()` for project-local discovery.

### Added — Refreshed agent portraits

- All 10 seed-agent profile pictures (Marcus, Lena, Diego, Aiko, Sven,
  Priya, Maya, Elena, Javier, Noah) regenerated with Higgsfield Soul V2
  — consistent studio aesthetic, soft natural daylight, light grey
  backdrop, persona-matched outfits and expressions.
- 20-image generic avatar pool for user-created custom agents
  regenerated alongside the seeds, with a broader demographic mix so the
  pool fits any role.

## 1.3.0 — Paperclip-port (6 features)

Ports six high-leverage ideas from the paperclip analysis into the
harness: cheaper Claude calls (prompt-bundle cache), continuity across
runs (per-project summary), robustness under load (max-turns retry +
atomic checkout), cost-aware orchestration routing (phase-based
Thompson roles), and a CI regression safety net (promptfoo evals).
One Drizzle migration (`0008_paperclip_port.sql`) covers all schema
additions. Three new background workers, one new web route. 33 new
unit/integration tests; full suite stays green (206 dashboard-server,
90 orchestrator).

### Added — Phase-based routing (F1)

- `pickFixed(model, role)` in `router/thompson.ts` — hard-picks a
  model with sentinel sampleId `'NO_OP'` so orchestration phases
  (context-ingest, status-post) don't consume the Thompson sample
  budget reserved for substantive picks.
- `recordOutcome` early-returns on `'NO_OP'` so callers share one
  code path.
- `pickModel('planner')` renamed to `pickModel('planner-substantive')`;
  `/api/insights/router-priors` and the Insights table surface a new
  `phase` column derived from the role suffix.

### Added — Atomic run checkout (F2)

- `runs.checkout_token` column + `tryCheckoutRun(runId, from, to)` /
  `releaseCheckout` transactional helpers under
  `src/checkout/atomic-checkout.ts`. Wraps the paused→running
  transition in a single SQLite transaction so concurrent
  autopilot-tick + manual `/resume` calls can't both win.
- Autopilot tick claims via `tryCheckoutRun` before calling
  `runtime.resumeRun`; `RunRuntime.resumeRun` made idempotent for
  already-`running` input (autopilot pre-flips).

### Added — Prompt-bundle cache (F3)

- `prompt_bundles` table keyed by SHA-256 of
  `(systemPrompt, sortedAllowedTools, model)`. Each bundle owns a
  stable cwd + Claude session id under `<HARNESS_DATA_DIR>/prompt-bundles/`.
- `RunAgentTurnOpts` gains `cwd?`, `resumeSessionId?`, `bundleKey?`.
  `runAgentTurn` reuses the bundle's cwd (skips `mkdtemp`/`rm` when
  stable) and records captured `task.session-id` events back via
  `recordSessionId(bundleKey, sessionId)`.
- `invokeSkill` looks up / upserts the bundle and threads
  `cwd + resumeSessionId + bundleKey` through to `runAgentTurn`, so
  repeated skill invocations hit Anthropic's prompt cache.
- New `GET /api/prompt-bundles` + `DELETE /api/prompt-bundles/:key`
  routes. New web route `/prompt-bundles` (sidebar entry, lucide
  Database icon) lists cached bundles with reset action.
- `prompt-bundle-evict` worker — daily 04:00 cron, 7-day TTL.

### Added — Run-continuation summary (F4)

- `run_summaries` table (one row per terminal run, FK-cascaded to
  runs + projects).
- `run-summary/summarizer.ts` — `buildTranscript(runId)` produces a
  ≤24KB compact transcript from events; `summarizeRun(opts)` invokes
  the existing `summarize-thread` skill, truncates to 8KB, persists
  with heuristic mode detection (implement/plan/review). Idempotent
  — `INSERT OR IGNORE` semantics + early-return on existing row.
- `RunRuntime` accepts an optional `skillRegistry` dep. On terminal
  outcome, fires a `void (async () => summarizeRun(...))()` IIFE
  alongside the existing trajectory-store hook.
- `run-summary-fallback` worker — 15-minute cron, catches runs that
  terminated without a summary (e.g. server crash mid-hook).
- `getLatestSummaryForProject(projectId)` injected into the planner's
  `additionalContext` alongside ReasoningBank lessons, so a new plan
  inherits state from the prior run.
- `GET /api/insights/run-summaries[?projectId=...]` + a "Recent run
  summaries" section in Insights.

### Added — Max-turns retry (F5)

- Defense-in-depth detection in `subprocess.ts`: primary via
  stream-json `result.num_turns >= maxTurns`, fallback via stderr
  pattern (`/max[- ]turns?\s*(exceeded|reached|exhausted)/i`).
  Emits new `task.max-turns-exhausted` event variant alongside
  `task.failed` with `error: 'max-turns-exhausted'`.
- Walker captures the signal into `runErrorReason = 'max_turns'`
  and propagates via `onRunState` (RunState gains
  `errorReason?: string | null`).
- `runs.error_reason / retry_count / next_retry_at` columns +
  composite index. `persistRunPatch` computes `nextRetryAt` from
  the graduated backoff `[2, 10, 30, 120]` minutes with ±25% jitter.
- `retry-max-turns` worker — 2-minute cron, atomically claims via
  `tryCheckoutRun('failed' → 'paused')`, bumps `retryCount` before
  the resume attempt (crash safety), capped at 4 retries.
- RunView surfaces an amber "Max-turns (N/4 retries, next at …)"
  badge when `errorReason === 'max_turns'`.

### Added — Promptfoo eval harness (F6)

- New top-level `evals/` directory: `promptfoo.config.ts` (provider:
  `anthropic:messages:claude-haiku-4-5-20251001`), one YAML case per
  seed skill (`summarize-thread`, `deep-research`, `doctor`,
  `audit-orphan-runs`, `auto-doc`) plus a `manager-directives.yaml`
  case asserting correct `<<ACTION>>{...}<<END>>` formatting.
- Root `pnpm eval` / `pnpm eval:view` scripts.
- CI `evals` job — opt-in via `vars.RUN_EVALS == 'true'` repo variable
  (secret-gating done inside the step since GitHub forbids
  `secrets.*` in job-level `if:`).

### Fixed

- pnpm peer-dep duplication: promptfoo's transitive
  `drizzle-orm@0.45.2` pulled `better-sqlite3@12.9.0` alongside our
  app's `11.10.0`, causing pnpm to specialize our
  `drizzle-orm@0.36.4` into two physical paths. TypeScript saw the
  exports as distinct types → CI typecheck exploded with 738
  cascading errors. Added `pnpm.overrides: { "better-sqlite3":
  "^11.10.0" }` to collapse the resolution.

## 1.2.0 — Mission Control redesign

Visual + structural overhaul. The dashboard adopts the Linear-cockpit
design DNA (semantic state tokens, motion-token scale, sticky
backdrop-blur topbar, `tabular-nums` everywhere) and the placeholder
`/` welcome card is replaced with a real overview that surfaces every
active run across all projects in one screen.

### Added — foundation polish (#34, Phase 1)

- Semantic CSS vars `--success / --warning / --info` (light + dark)
  plus Vault motion tokens (`--ease-smooth/sharp/spring/power`,
  75/150/200/300/500ms duration scale).
- `<StatusDotBadge>` — Linear-style dot pill with tone mapping for
  every status the harness emits (`running`, `success`, `failed`,
  `pending`, `paused`). Pulse variant for live runs. Replaces three
  hardcoded Tailwind tone-maps in Sidebar, ProjectDetail, RecentRuns.
- `<AnimatedCounter>` — easeOutQuart count-up over 1100ms,
  `prefers-reduced-motion`-aware, tabular-nums.
- `<ThemeToggle>` finally exposes the dormant Zustand theme store as
  a UI control. TopBar gains sticky positioning + backdrop-blur.
- `App.tsx` wraps `<Outlet />` in `max-w-screen-2xl` so the layout
  stops sprawling on 4K screens.
- CSS-only `.border-beam` keyframe (`conic-gradient` + `@property
  --beam-angle`) for active-run cards, with reduced-motion fallback.

### Added — Mission Control home (#34, Phase 2)

- New server endpoint `GET /api/runs?include=project` joins runs →
  plans → projects (no N+1 lookups).
- New server endpoint `GET /api/runs/summary?windowDays=7` — single
  windowed scan producing `activeCount`, `totalRuns`, `totalTokens`,
  `successRate`, `avgDurationMs`, `outcomeCounts`, plus pre-bucketed
  `tokensByDay` / `runsByDay` arrays so the area chart never gaps.
- Recharts via shadcn-style theme variables: `<TokenAreaChart>`
  (area + linearGradient) and `<OutcomeDonut>` (pie with legend +
  percent column).
- `<KpiTile>` (4 tiles: Active runs, Tokens 7d, Success rate,
  Avg duration). Animated counter + tone accent band.
- `<LiveNowGrid>` — cards for runs in `running` or `paused` state
  with the `.border-beam` exclusively on actively running ones.
  Ticking duration timer (1s, no extra fetches).
- `<GlobalRunsTable>` — client-sorted on Project / Started /
  Duration / Tokens.
- `Home.tsx` rewritten end-to-end. EN+DE i18n keys throughout.

### Added — cockpit layer (#34, Phase 3)

- `<CommandPalette>` (cmdk, `⌘K` / `Ctrl+K`) — fuzzy search across
  projects, last 50 runs, quick actions (jump to Mission Control,
  toggle theme). Mounted globally inside the Shell so any route
  can summon it.
- `<Breadcrumbs>` — URL-pattern-based, resolves project ids to
  project names via React Query. Mission Control → Project →
  (Team Builder | Plan Editor | Run id).
- TopBar gains a `⌘K` trigger button between content and theme
  toggle, with kbd hint showing the shortcut.

### Test additions

- 2 new server tests for the global runs and summary endpoints.
- Adjusted `App.test`, `TopBar.test`, and the Playwright smoke spec
  for the breadcrumb/H1 dual-occurrence of "Team Builder".

## 1.1.0 — i18n + project workflow polish

40 commits past v1.0.0. The biggest user-visible additions: a
language toggle (EN default ↔ DE), a dedicated project-detail
overview view, a `Run-again` button on terminal-status runs, and
much richer team-template descriptions. Plus four critical fixes
discovered while exercising the GitHub plugin-install path
end-to-end.

### Added — i18n foundation (#29)

- `react-i18next` + `i18next` + `i18next-browser-languagedetector`
  wired into `apps/dashboard-web`.
- `LanguageToggle` in TopBar — flag + native name dropdown,
  persists to `localStorage['agent-harness-lang']`, navigator-lang
  detection on first load.
- `apps/dashboard-web/src/i18n/locales/{en,de}/common.json` cover
  ~150 strings on the entry-path components: TopBar, Sidebar +
  NewProject dialog, FirstRunModal, plus the new ProjectDetail
  view and richer TemplatePicker.

### Added — richer team templates (#30)

- `templateSchema` extended with optional `useCases`, `bestFor`,
  `notRecommendedFor`, `complexity` (`simple` / `medium` /
  `complex`), `expectedDurationMinutes`. All four built-ins
  populated.
- `TemplatePicker.tsx` rewritten: complexity badge (color-coded),
  duration badge, expand-to-see-detail panel with three labelled
  bullet sections.

### Added — project-detail view + Run-again (#31)

- New `/projects/:projectId` route renders a project overview:
  Goal / Repo path / Team summary cards, Plan-status card with
  three actions (Open Team, Open Plan, Start new run gated on
  locked plan), Run history table with status / outcome /
  duration / tokens / aggregates.
- Sidebar project link now lands on the detail view (was: jumped
  straight into TeamBuilder).
- `RunView` shows a `Run again` button when the run reaches a
  terminal status (`completed | failed | cancelled`), POSTing
  `/api/runs` with the same `planId`.

### Fixed — plugin install path (#26, #27, #28)

The GitHub plugin-install path had three blockers caught only by
running `claude plugin install` end-to-end against the live CLI
(2.1.131). Each was a one-line schema mismatch; subsequent installs
all succeed.

- `marketplace.json` source must be `"./"` (was `"."`).
- `plugin.json` must NOT declare `agents/commands/skills/hooks`
  paths — Claude Code auto-discovers them by directory convention.
- `hooks.json` must wrap events in a top-level `"hooks"` record.

### Fixed — bootstrap + serve-web (#21)

- `scripts/launch-dashboard.{ps1,sh}` auto-bootstrap on first
  invocation (`pnpm install --frozen-lockfile && pnpm build`)
  when `apps/dashboard-server/dist/server.js` is missing. Solves
  the previous "Dashboard server not built" dead-end every fresh
  `claude plugin install` user hit.
- Both launchers now set `HARNESS_SERVE_WEB=1` so `/` serves the
  SPA instead of returning 404.
- README install path uses the GitHub source
  (`Samuel0101010/agent-harness`) and the correct marketplace
  name (`agent-harness-local`).

### Fixed — modern stream-json + tool-use events (#22, #23)

- `subprocess.ts:mapCliEvent` extended with an `assistant`-frame
  case that walks `message.content[]` and emits `task.text-delta`
  per `text` item and `task.tool-use` per `tool_use` item.
  `thinking` items skipped (private chain-of-thought stays out of
  the dashboard). Without this, the live tail and per-task
  tool-use stream were silently empty during real-Claude runs.
- `runtime.ts` `task.tool-use` filter removed — events now persist
  + broadcast like every other event type. Live verified against
  `mcp__agent-harness-memory__memory_set` and `Write` calls.

### Fixed — PowerShell launcher logging (#22)

- `launch-dashboard.ps1` redirects stdout / stderr to
  `server.log` / `server.err.log` in `dataDir`, mirroring the
  POSIX launcher's nohup redirect.

### Changed — license

- All eight `package.json` files + `plugin.json` now declare
  `Apache-2.0` (was `UNLICENSED`). Repository ships `LICENSE`
  (canonical Apache-2.0 text). Repo remains private; the license
  declaration takes effect whenever it (or the plugin via
  marketplace) is made public.

### Docs — final truth pass (#25)

Eight stale claims fixed across `README.md`,
`docs/architecture.md`, `docs/memory-mcp.md`,
`docs/development.md` (M1 framing, route list, table count,
budget defaults, env-var coverage). New `docs/templates.md` and
`docs/replan.md` filled the two original-plan deliverables that
were never written. New `docs/solutions/` entries: replan
branch-prefix carried-over deps (Round 5 CRITICAL),
`claude-cli` session-id capture, better-sqlite3 busy_timeout
(under-write contention).

### Audits

Five rounds of post-v1.0 hardening landed earlier in this cycle
(#14–#20): replan branch-parent for carried-over `done` deps,
session-id capture, MCP `busy_timeout=5000` pragma, recovery
hardening (transaction wrap), pool drain on terminate, kill
race-conditions on Windows, byte-correct `octet_length` for memory
sizes, planner.md role-agnostic rewrite, plus 23 PR-#16/#17
verification corrections.

## 1.0.0 — Personal-use complete

The plan written 2026-05-05 finished as scoped: M1 vertical slice,
M1.5 hardening, plus M2-M5 feature work, plus four `/harness-*`
plugin skills. Six real-Claude validation runs documented under
`docs/real-run-notes.md` (~$15-25 in subscription quota total).

### Added — M2: variable team

- `Team` is a `{roles: AgentSpec[]}` array (1..8 roles, kebab-case
  unique names matching `^[a-z][a-z0-9-]*$`, model enum
  `opus|sonnet|haiku`, systemPrompt 40-4000 chars).
- Drizzle migration `0002_variable_team.sql` rewrites legacy
  `{architect,developer,qa}` rows in place (idempotent).
- Planner `DAG_SCHEMA_BLOCK` describes the new shape; planner prompt
  enumerates configured role names verbatim with cardinality.
- Walker resolves agent via `team.roles.find(r => r.role === ...)`;
  emits `task.failed` with "role 'X' not in team" when the lookup
  misses (checked before worktree allocation).
- Server team route validates the new shape; 6 new endpoint tests.
- Web `TeamBuilder` rewrite: `TeamRoleCard` + `TeamRoleAddButton`
  components, model dropdown, per-role remove, inline duplicate
  detection blocks Save.

### Added — M3: shared-memory MCP

- New workspace package `@agent-harness/memory-mcp`: stdio MCP
  server exposing `memory.{set,get,list,delete}` backed by per-run
  SQLite WAL.
- Walker spawns the server per task via `claude -p --mcp-config
  --strict-mcp-config`. `SubprocessPool.defaultMcpConfigPath`
  injects the config path so the walker stays oblivious.
- Per-run config + DB live under `<HARNESS_DATA_DIR>/{mcp-configs,
  memory}/<runId>.{json,db}`.
- Default team `allowedTools` include the fully-qualified
  `mcp__agent-harness-memory__memory_set/get/list` (delete
  intentionally excluded).
- `docs/memory-mcp.md` — usage, security note, on-disk layout,
  inspection guide.

### Added — M4: team templates

- Four built-in templates: `ts-library` (4 roles), `python-backend`
  (4), `refactor-squad` (3), `data-pipeline` (4). Validated against
  `templateSchema` at module load.
- `GET /api/team-templates` returns built-ins + on-disk user
  templates merged & sorted (on-disk wins on id collision).
- `POST /api/team-templates` writes to
  `<HARNESS_DATA_DIR>/templates/<id>.json`.
- Web `TemplatePicker` in NewProject dialog (max-h-48, scrollable).
  Goal pre-fills from template's first `suggestedGoal`. "Save as
  Template" Dialog on TeamBuilder.
- `apps/dashboard-server/scripts/copy-templates.mjs` ferries
  template JSONs into `dist/` on build.

### Added — M5: QA-driven replan

- New `parent_plan_id` column on plans (Drizzle migration 0003).
- Walker `replanOnQAFailure` callback. When a `qa`-role task fails
  terminally, walker calls server's `replan.ts` helper which
  composes an extended goal with the QA error context, runs
  `generatePlan`, persists a child plan with `parent_plan_id`
  pointing at the failed plan, and returns it for the walker to
  swap in. Capped at 1 replan per run (`MAX_REPLANS_PER_RUN`).
- Branches namespaced by `v<N>` after replan: v1 keeps the original
  `harness/<runId>/<taskId>` form; v2+ get `harness/<runId>/vN/<taskId>`
  to avoid `git worktree add -b` collisions on reused task ids.
- Two new events: `qa.replan-triggered`, `qa.replan-exhausted`.
- `GET /api/plans/:id/chain` walks `parent_plan_id` ancestors
  newest-first.
- Web `PlanVersionBadge` renders "v2 (replanned)" for chain >1, with
  ancestor list in the title attribute. Mounted in PlanEditor +
  RunView.
- `generatePlan` extracted from `routes/plans.ts` into
  `apps/dashboard-server/src/orchestrator/planner-runner.ts` so the
  runtime can call it without going through HTTP.

### Added — Stage 1: foundation hardening

- New `harness.verify-failed` event with `{taskId, attempt,
  failures: [{kind, cmd, exitCode, tail}], output}` payload —
  replaces opaque `exit code 1` with full forensics.
- `composeTaskPrompt` truncates retry-error context to first 30 +
  last 60 lines with `[… N omitted …]` marker (was inflating retry
  prompts to thousands of lines).
- `successCriteria.preflight` runs once before build/test/lint and
  short-circuits the rest on failure with `kind: 'preflight'`.
- `task.usage` parser reads modern `{type:'result', usage:{...},
  num_turns}` frame (token telemetry was always 0/0 before).
- `verification.ts` `defaultExec` injects `CI=true` + `npm_config_os`
  + `npm_config_arch` so pnpm install works correctly across
  worktree-chained `node_modules` and stale global pnpm config.

### Added — Stage 6: plugin skills

- Four `SKILL.md` files under `skills/`: `harness-new-run`,
  `harness-resume`, `harness-inspect`, `harness-diagnose`. The
  dashboard is now optional for the most common workflows.
- `GET /api/runs/:runId/events?limit=&type=` for the diagnose skill.
- `.claude-plugin/plugin.json` bumped to register the `skills`
  directory.

### Changed

- Plugin manifest version bumped to `1.0.0`.

## 0.1.5 — M1.5 Foundation hardening (released as part of M1.5 PR)

### Fixed

- Walker now chains downstream worktrees off parent task branches and
  auto-commits each task's output, so a real Claude run produces
  consolidated artifacts in `<repoPath>` instead of evaporating with
  the worktree (Stage A).
- Rate-limit pause no longer auto-resumes by default
  (`HARNESS_AUTO_RESUME_RATE_LIMIT` to opt in); auth-probe failure
  blocks `POST /api/runs` with HTTP 503; walker pauses with
  `pausedReason='consecutive-failures'` after 3 consecutive task
  failures.

### Changed

- Balanced runtime defaults — `maxParallel=2` (was 3),
  `budgetMinutes=120` (was 360), `interTaskPacingMs=5000` (new).

### Added

- `tests/compliance` — static guards forbidding direct Anthropic
  endpoints, `x-api-key` headers, and credential file access. CI verify
  step includes the new package.
- Per-project daily-runs counter in sidebar; one-time first-run
  acknowledgment modal explaining ToS responsibility.
- `docs/anthropic-compliance.md`; README "Anthropic Terms of Service"
  section.
- `HARNESS_AUTO_RESUME_RATE_LIMIT`, `HARNESS_INTER_TASK_PACING_MS`,
  `HARNESS_AUTH_MODE` env vars.
- Diamond-dep merge support: multi-parent tasks merge other parents
  into the dependent task's worktree via `git merge --no-ff`.
- Final result branch `harness/<runId>/result` consolidating all leaf
  task branches at run end.

## 0.1.0 - M1 vertical slice (unreleased)

The first end-to-end milestone: a single goal can drive a 3-role team through plan generation, execution, and verification, with full pause/resume across rate-limit windows and server restarts.

### Added

- Claude Code plugin manifest (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) plus four agent specs in `agents/` (architect, developer, qa, planner), the `/harness-dashboard` slash-command, `hooks/hooks.json` with `PreCompact` + `SessionStart` wiring, and cross-platform launcher scripts in `scripts/`.
- `packages/schemas` — Drizzle schema with 9 tables (`projects`, `teams`, `plans`, `tasks`, `runs`, `events`, `checkpoints`, `rate_windows`) plus Zod schemas for `Plan`, `HarnessEvent`, `AgentSpec`, `Team`, including `validateDag` for structural plan invariants.
- `packages/orchestrator`:
  - `runClaude` subprocess runner that spawns `claude -p`, parses NDJSON to `HarnessEvent`s, and supports a `__mockBin` test seam.
  - `SubprocessPool` with `terminateAll` for graceful cancellation.
  - `Walker` — DAG dispatch with pause/resume, rate-limit auto-resume timer, budget caps, single-retry policy, and resume-after-shutdown via `initialState`.
  - `runVerification` (E1) running `build`/`test`/`lint`/`custom` shell gates with per-command timeouts.
  - `addWorktree` / `removeWorktree` git helpers for per-task isolation.
  - `probeSubscriptionAuth` and `detectRateLimit` heuristics.
- `apps/dashboard-server`:
  - Fastify 5 + `@fastify/cors` + `@fastify/websocket`.
  - Routes: `/api/health`, projects (CRUD), teams (per project), plans (generate, get, patch, lock), runs (start, get, pause, resume, cancel, replay-checkpoint, list-by-project, global list with `?resumable=true`).
  - `RunRuntime` wiring Walker into DB + WS, with per-run snapshots every 10 minutes.
  - Bootstrap that runs migrations and recovers orphaned `running` runs to `paused`/`shutdown`.
  - Graceful shutdown that pauses every walker with `pausedReason='shutdown'` and closes Fastify + SQLite within a 30 s hard timeout.
- `apps/dashboard-web`:
  - Vite + React 19 + Tailwind v4 + shadcn.
  - Routes: TeamBuilder (3 role cards), PlanEditor (React Flow + dagre layout, side-panel inline edit), RunView (5-column kanban: pending/running/verifying/done/failed; live tail; resource bar; rate-limit countdown).
  - Sidebar with project list, new-project dialog, recent-runs preview.
  - TopBar mirrors run resource bar.
- Documentation: `README.md` rewrite, `docs/architecture.md`, `docs/agents.md`, `docs/development.md`, this `CHANGELOG.md`.

### Notes

- Subscription-only auth: every subprocess inherits `~/.claude/` and has `ANTHROPIC_API_KEY` actively unset.
- Token usage is informational only; the gated budgets are wallclock minutes, total turns, and parallel pool size.
- 167 unit tests plus 1 Playwright end-to-end smoke test (mock-CLI mode) green at M1 close. All packages typecheck and build.

### M1 review fixes (post-close)

- Fixed: rate-limit pauses no longer auto-resume after server restart; `fixUpAbruptCrashes` rewrites them to `paused/shutdown` so the user explicitly resumes (C1).
- Fixed: `task.usage` now treated as cumulative (`Math.max`) on per-task counters; run-level totals updated by delta to match `claude -p --output-format stream-json` semantics (H1).
- Fixed: dropped unused `'concerns' | 'fail'` task-outcome enum values; `task.completed` is `'pass'` only in M1 (H2).
- Fixed: bootstrap now runs a one-shot subscription-auth probe and surfaces the result via `GET /api/health.authProbe` (skipped when `HARNESS_MOCK_CLI=1`); never fails bootstrap (H3).
- Fixed: `teams.rolesJson` stores the slotted `Team` object directly; dropped the legacy array<->object conversion helpers (H4).
- Fixed: walker forwards the per-task abort signal to `runVerification` so cancel/pause halts verifier subprocesses promptly (M1).
- Fixed: documented `runVerification` SIGTERM→SIGKILL escalation (5s grace via execa's `forceKillAfterTimeout`); migrated to execa v9's `cancelSignal` option (M2).
- Fixed: `walker.cancel()` removes worktrees of currently-running tasks on user-cancel; preserves them on `budget_exceeded` for forensics; also calls `pool.terminateAll()` for slot hygiene (M3, L1).
- Fixed: resume path logs structured `resume-no-session` warning when a task with a worktree but no `sessionId` is restarted from scratch (M4).
- Fixed: server-side `emit` filter drops `task.tool-use` events from persistence and WS broadcast; schema entry preserved for future tool-timeline UI (M5).
- Documented planner-event audit gap: events broadcast for live UI, not persisted (no parent `runs` row); listed under architecture.md "Known limitations" (M6).
- Fixed: `recompute()` in `apps/dashboard-web/src/store/run.ts` no longer constructs a dead `aggregates` object (L2).
- Fixed: `PATCH /api/plans/:planId` returns 400 `empty-patch` when `dagJson` is missing (L3).
- Fixed: `scripts/launch-dashboard.ps1` uses `-NoNewWindow` instead of the conflicting `-WindowStyle Hidden` (L5).
