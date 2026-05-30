import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';

// ----- projects -----
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  goal: text('goal').notNull(),
  repoPath: text('repo_path').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  // Production-loop toggles (migration 0009). When `autoMergeOnSuccess` is
  // true the harness fast-forward-merges the result branch into main after
  // every successful run so the user's working tree picks up the finished
  // code without a manual `git merge`. When `selfHealingEnabled` is true
  // the harness scans docs/security-review.md + docs/qa-report.md for
  // HIGH/CRITICAL findings after every successful run and, if any remain
  // AND chain_iteration < maxChainIterations, spawns a follow-up
  // hardening run automatically.
  autoMergeOnSuccess: integer('auto_merge_on_success', { mode: 'boolean' }).notNull().default(true),
  selfHealingEnabled: integer('self_healing_enabled', { mode: 'boolean' }).notNull().default(false),
  maxChainIterations: integer('max_chain_iterations').notNull().default(3),
  // Project-level autopilot defaults (migration 0010). When a new run is
  // created via startRun, these are copied into the run row at insert. The
  // per-run AutopilotToggle still overrides for the active run; this is just
  // the seed value so users don't have to re-toggle autopilot on every new
  // run started against the same project.
  defaultAutopilotMode: integer('default_autopilot_mode', { mode: 'boolean' })
    .notNull()
    .default(false),
  defaultAutopilotBudgetMinutes: integer('default_autopilot_budget_minutes'),
  defaultAutopilotBudgetTokens: integer('default_autopilot_budget_tokens'),
  // Runtime-verification toggles (migration 0011, v1.8). When
  // `runtimeVerifyEnabled` is true the post-run hook adds a runtime-verify
  // pass before auto-merge: boot the app, probe the dev URL, run any
  // declared Playwright tests, and block the release-gate on failure.
  // `runtimeVerifyDevCmd` and `runtimeVerifyProbeUrl` may be NULL, in which
  // case detect-project-type infers them from package.json.
  runtimeVerifyEnabled: integer('runtime_verify_enabled', { mode: 'boolean' })
    .notNull()
    .default(true),
  runtimeVerifyDevCmd: text('runtime_verify_dev_cmd'),
  runtimeVerifyProbeUrl: text('runtime_verify_probe_url'),
  // Native-packaging target (migration 0017, v1.9). 'web' is the default and
  // means "no packaging step — the result is a git branch". Any other value
  // enables the post-verify packager agent that scaffolds Tauri/Electron and
  // produces a downloadable installer at `artifactPath`.
  packageTarget: text('package_target', {
    enum: ['web', 'tauri-exe', 'electron-exe', 'pkg-bin'] as const,
  })
    .notNull()
    .default('web'),
  artifactPath: text('artifact_path'),
  // v2.0.0 (migration 0018, Phase 8). When `leadEnabled` is true the Team
  // Lead (Theo) agent is available for this project: the user can trigger
  // POST /lead/tick to get a synthesis of project state + events + handoffs
  // and routing decisions, and the planner auto-injects an optional `lead`
  // checkpoint node into newly generated plans. Disabled by default for
  // backwards-compat; flip via PATCH /api/projects/:id.
  leadEnabled: integer('lead_enabled', { mode: 'boolean' }).notNull().default(false),
});
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export const packageTargetValues = ['web', 'tauri-exe', 'electron-exe', 'pkg-bin'] as const;
export type PackageTarget = (typeof packageTargetValues)[number];

// ----- teams -----
/**
 * Storage shape for `teams.rolesJson`. Mirrors the Zod `Team` from ./plan.ts
 * but is defined locally so db.ts stays decoupled from plan.ts. Physical
 * storage is TEXT-JSON; only the TypeScript view changes.
 */
interface AgentSpecLite {
  role: string;
  model: 'opus' | 'sonnet' | 'haiku';
  allowedTools: string[];
  systemPrompt: string;
  /**
   * Optional reference to a row in `agents` (Model B). When set, the agent
   * config can be hydrated from the registry and the role inherits
   * persistent-memory semantics (cross-project chat threads). Inline values
   * remain authoritative for orchestrator spawns to keep backwards-compat;
   * the server may overwrite them from the agent on read if hydration is
   * requested explicitly.
   */
  agentId?: string;
}
export interface TeamRolesJson {
  roles: AgentSpecLite[];
}

export const teams = sqliteTable('teams', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  rolesJson: text('roles_json', { mode: 'json' }).$type<TeamRolesJson>().notNull(),
});
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;

// ----- plans -----
export const planStatusValues = ['draft', 'locked', 'running', 'done', 'failed'] as const;
export type PlanStatus = (typeof planStatusValues)[number];

export const planKindValues = ['initial', 'iteration', 'hardening'] as const;
export type PlanKind = (typeof planKindValues)[number];

export const plans = sqliteTable('plans', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  dagJson: text('dag_json', { mode: 'json' }).$type<unknown>().notNull(),
  status: text('status', { enum: planStatusValues }).notNull(),
  // v2.0.27 (migration 0019). Plans are selected as "latest" by recency; the
  // PK is a random UUIDv4 (not time-sortable), so ordering by id returned a
  // stale plan ~50% of the time for multi-plan (iteration) projects. This
  // timestamp is the authoritative recency key. Existing rows backfill to 0
  // in the migration so any post-migration plan correctly outranks them.
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  // Nullable for root plans; set to the predecessor's id when this is a QA-replan child.
  // FK lives in the SQL migration (self-referential Drizzle .references() has ordering issues).
  parentPlanId: text('parent_plan_id'),
  // v1.9 (migration 0016). Distinguishes greenfield plans ('initial') from
  // user-driven follow-up plans that consume project-state + change-requests
  // ('iteration') and from auto-spawned hardening passes ('hardening').
  kind: text('kind', { enum: planKindValues }).notNull().default('initial'),
  // v1.9 (migration 0016). For iteration plans: the project_states row this
  // plan was built against, so we can debug what the planner thought the
  // codebase looked like. NULL for initial plans. FK lives in SQL only to
  // sidestep cross-table ordering issues at the Drizzle layer.
  parentStateId: text('parent_state_id'),
});
export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;

// ----- tasks -----
export const taskStatusValues = [
  'pending',
  'ready',
  'running',
  'done',
  'failed',
  'skipped',
  // v1.7.13 — distinct from 'failed' so the UI can show user-cancelled tasks
  // in their own bucket. Only the explicit user-cancel path (Walker.cancel)
  // writes this; tasks cancelled by upstream dep-failure cascade stay
  // 'failed' since they're a failure cascade, not a user intent.
  'cancelled',
] as const;
export type TaskStatus = (typeof taskStatusValues)[number];

// Kept as a plain string alias because tasks.role is no longer constrained
// to an enum at the schema layer (since M2/2.1).
export type TaskRole = string;

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').notNull(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    title: text('title').notNull(),
    deps: text('deps', { mode: 'json' }).$type<string[]>().notNull(),
    status: text('status', { enum: taskStatusValues }).notNull(),
    worktreeBranch: text('worktree_branch'),
    sessionId: text('session_id'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    turnsUsed: integer('turns_used').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.planId, t.id] }),
  }),
);
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

// ----- runs -----
export const runStatusValues = [
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof runStatusValues)[number];

export const runOutcomeValues = ['success', 'failure', 'budget_exceeded', 'cancelled'] as const;
export type RunOutcome = (typeof runOutcomeValues)[number];

export const runPausedReasonValues = [
  'rate-limit',
  'user',
  'shutdown',
  'consecutive-failures',
] as const;
export type RunPausedReason = (typeof runPausedReasonValues)[number];

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  planId: text('plan_id')
    .notNull()
    .references(() => plans.id, { onDelete: 'cascade' }),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  outcome: text('outcome', { enum: runOutcomeValues }),
  status: text('status', { enum: runStatusValues }).notNull(),
  checkoutToken: text('checkout_token'),
  budgetMinutes: integer('budget_minutes').notNull(),
  budgetTurns: integer('budget_turns').notNull(),
  maxParallel: integer('max_parallel').notNull(),
  tokensInTotal: integer('tokens_in_total').notNull().default(0),
  tokensOutTotal: integer('tokens_out_total').notNull().default(0),
  turnsTotal: integer('turns_total').notNull().default(0),
  pausedReason: text('paused_reason', { enum: runPausedReasonValues }),
  resumeAt: integer('resume_at', { mode: 'timestamp_ms' }),
  autopilotMode: integer('autopilot_mode', { mode: 'boolean' }).notNull().default(false),
  autopilotBudgetMinutes: integer('autopilot_budget_minutes'),
  autopilotBudgetTokens: integer('autopilot_budget_tokens'),
  autopilotStartedAt: integer('autopilot_started_at', { mode: 'timestamp_ms' }),
  errorReason: text('error_reason'),
  retryCount: integer('retry_count').notNull().default(0),
  nextRetryAt: integer('next_retry_at', { mode: 'timestamp_ms' }),
  // Self-healing chain pointers (migration 0009). `parentRunId` is set
  // when this run was spawned automatically as a follow-up to another
  // run. `chainIteration` is 0 for user-launched runs and N for the
  // N-th self-healing follow-up. The chain stops growing when either
  // (a) the result branch's docs/*.md contain no remaining HIGH+
  // findings or (b) chainIteration >= project.maxChainIterations.
  parentRunId: text('parent_run_id'),
  chainIteration: integer('chain_iteration').notNull().default(0),
});
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;

// ----- events -----
export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  // Free-form text — tasks now use a compound (plan_id, id) primary key, so a
  // single-column FK is no longer expressible. Treated as audit/log only.
  taskId: text('task_id'),
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
  ts: integer('ts', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type HarnessEventRow = typeof events.$inferSelect;
export type NewHarnessEventRow = typeof events.$inferInsert;

// ----- checkpoints -----
export const checkpoints = sqliteTable('checkpoints', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  snapshotPath: text('snapshot_path').notNull(),
  ts: integer('ts', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type Checkpoint = typeof checkpoints.$inferSelect;
export type NewCheckpoint = typeof checkpoints.$inferInsert;

// ----- agents (Model B: global agent registry) -----
//
// Agents are first-class user-created entities. They carry persistent identity
// across projects: a project's team REFERENCES agents, and chat threads are
// scoped to an agent (optionally also to a project). When the user runs
// /api/agents/:id/threads/:tid/messages, the server spawns `claude -p` with
// the agent's systemPrompt + thread history.

export const agentModelValues = ['opus', 'sonnet', 'haiku'] as const;
export type AgentModel = (typeof agentModelValues)[number];

export const agentKindValues = ['seed', 'user', 'team-backfill'] as const;
export type AgentKind = (typeof agentKindValues)[number];

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  // Display name. Free-form; not unique on the SQL level (UI nudges uniqueness
  // but doesn't block — two "architect" agents can coexist with different
  // descriptions).
  name: text('name').notNull(),
  model: text('model', { enum: agentModelValues }).notNull(),
  systemPrompt: text('system_prompt').notNull(),
  allowedTools: text('allowed_tools', { mode: 'json' }).$type<string[]>().notNull(),
  // Optional accent for UI (HSL hue 0–360 as a string, or a CSS color). UI only.
  color: text('color'),
  description: text('description'),
  // Path to a profile picture under /avatars/, or null for initials fallback.
  avatarUrl: text('avatar_url'),
  // Stable key for built-in seed agents (e.g. 'manager', 'frontend-dev').
  // NULL for user-created. Backed by a UNIQUE partial index so the seeder is
  // idempotent across boots.
  seedKey: text('seed_key'),
  // 'seed' (built-in), 'user' (created via UI), 'team-backfill' (created from
  // a project team during the Model B migration).
  kind: text('kind', { enum: agentKindValues }).notNull().default('user'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;

// ----- agent threads -----
//
// One conversation context. Optional projectId binds the thread to a project
// (so the agent has implicit "this is what we're discussing" context); null
// means cross-project / global. lastMessageAt mirrors updatedAt for sort order.

export const agentThreads = sqliteTable('agent_threads', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
  title: text('title'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type AgentThread = typeof agentThreads.$inferSelect;
export type NewAgentThread = typeof agentThreads.$inferInsert;

// ----- agent messages -----
//
// One message in a thread. Role ∈ {user, assistant}. tokens columns are filled
// for assistant messages from the claude -p subprocess result; null for user
// messages and for failed assistant attempts.

export const messageRoleValues = ['user', 'assistant'] as const;
export type MessageRole = (typeof messageRoleValues)[number];

export const agentMessages = sqliteTable('agent_messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => agentThreads.id, { onDelete: 'cascade' }),
  role: text('role', { enum: messageRoleValues }).notNull(),
  content: text('content').notNull(),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  // null while assistant is still generating; set to elapsed ms on completion.
  durationMs: integer('duration_ms'),
  // Failure mode for assistant messages that errored (e.g. 'auth-failed',
  // 'rate-limit', 'timeout'). null on success.
  errorReason: text('error_reason'),
  // Which agent authored this message. NULL for user messages and for
  // system/compaction messages.
  authorAgentId: text('author_agent_id').references(() => agents.id, {
    onDelete: 'set null',
  }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type AgentMessage = typeof agentMessages.$inferSelect;
export type NewAgentMessage = typeof agentMessages.$inferInsert;

// ----- thread participants (chat v2) -----
//
// Many-to-many between agent_threads and agents. Each thread has 1 manager
// (role='manager') plus 0..N members (role='member'). The manager always
// receives unaddressed messages; @mentions or addressedTo route to specific
// members. Cascades on either side.

export const participantRoleValues = ['manager', 'member'] as const;
export type ParticipantRole = (typeof participantRoleValues)[number];

export const threadParticipants = sqliteTable(
  'thread_participants',
  {
    threadId: text('thread_id')
      .notNull()
      .references(() => agentThreads.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    role: text('role', { enum: participantRoleValues }).notNull().default('member'),
    joinedAt: integer('joined_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.threadId, t.agentId] }),
  }),
);
export type ThreadParticipant = typeof threadParticipants.$inferSelect;
export type NewThreadParticipant = typeof threadParticipants.$inferInsert;

// ----- chat actions (audit log of manager directives) -----
//
// Whenever the manager emits a <<ACTION>>{...}<<END>> directive that touches
// project state (create_project, start_run, add_member, consult), we persist
// the parsed payload + result here. Lets the UI surface "Manager created
// project X" cards and lets us debug failed directives after the fact.

export const chatActionKindValues = [
  'consult',
  'add_member',
  'create_project',
  'start_run',
  'invoke_skill',
  'generate_plan',
] as const;
export type ChatActionKind = (typeof chatActionKindValues)[number];

export const chatActionStatusValues = ['pending', 'ok', 'failed'] as const;
export type ChatActionStatus = (typeof chatActionStatusValues)[number];

export const chatActions = sqliteTable('chat_actions', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => agentThreads.id, { onDelete: 'cascade' }),
  messageId: text('message_id').references(() => agentMessages.id, {
    onDelete: 'set null',
  }),
  kind: text('kind', { enum: chatActionKindValues }).notNull(),
  payloadJson: text('payload_json', { mode: 'json' }).$type<unknown>().notNull(),
  resultJson: text('result_json', { mode: 'json' }).$type<unknown>(),
  status: text('status', { enum: chatActionStatusValues }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type ChatAction = typeof chatActions.$inferSelect;
export type NewChatAction = typeof chatActions.$inferInsert;

// Worker runs (cron-style background tasks: orphan-run audit, auto-doc, etc).
// Each run is one execution of a registered worker handler.

export const workerRunStatusValues = ['running', 'ok', 'failed'] as const;
export type WorkerRunStatus = (typeof workerRunStatusValues)[number];

export const workerRuns = sqliteTable('worker_runs', {
  id: text('id').primaryKey(),
  workerName: text('worker_name').notNull(),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  status: text('status', { enum: workerRunStatusValues }).notNull(),
  resultJson: text('result_json', { mode: 'json' }).$type<unknown>(),
  errorReason: text('error_reason'),
});
export type WorkerRun = typeof workerRuns.$inferSelect;
export type NewWorkerRun = typeof workerRuns.$inferInsert;

// ----- model router priors + samples (Thompson sampling) -----

export const modelRouterRoleValues = ['planner'] as const;
export type ModelRouterRole = (typeof modelRouterRoleValues)[number];

export const modelRouterModelValues = ['opus', 'sonnet', 'haiku'] as const;
export type ModelRouterModel = (typeof modelRouterModelValues)[number];

export const modelRouterPriors = sqliteTable(
  'model_router_priors',
  {
    role: text('role').notNull(),
    model: text('model').notNull(),
    alpha: real('alpha').notNull().default(1),
    beta: real('beta').notNull().default(1),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.role, t.model] }),
  }),
);
export type ModelRouterPrior = typeof modelRouterPriors.$inferSelect;

export const modelRouterSampleOutcomeValues = ['success', 'failure'] as const;
export type ModelRouterSampleOutcome = (typeof modelRouterSampleOutcomeValues)[number];

export const modelRouterSamples = sqliteTable('model_router_samples', {
  id: text('id').primaryKey(),
  role: text('role').notNull(),
  model: text('model').notNull(),
  takenAt: integer('taken_at', { mode: 'timestamp_ms' }).notNull(),
  outcome: text('outcome', { enum: modelRouterSampleOutcomeValues }),
  recordedAt: integer('recorded_at', { mode: 'timestamp_ms' }),
});
export type ModelRouterSample = typeof modelRouterSamples.$inferSelect;

// ----- trajectories (ReasoningBank Lite) -----

export const trajectories = sqliteTable('trajectories', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  prompt: text('prompt').notNull(),
  planJson: text('plan_json').notNull(),
  outcome: text('outcome').notNull(),
  termsJson: text('terms_json').notNull(),
  lessons: text('lessons'),
  tokensTotal: integer('tokens_total').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
export type Trajectory = typeof trajectories.$inferSelect;
export type NewTrajectory = typeof trajectories.$inferInsert;

// ----- hook events (F9: Claude Code telemetry) -----

export const hookEvents = sqliteTable('hook_events', {
  id: text('id').primaryKey(),
  event: text('event').notNull(),
  toolName: text('tool_name'),
  cwd: text('cwd'),
  payloadJson: text('payload_json').notNull(),
  receivedAt: integer('received_at', { mode: 'timestamp_ms' }).notNull(),
});
export type HookEvent = typeof hookEvents.$inferSelect;
export type NewHookEvent = typeof hookEvents.$inferInsert;

// ----- prompt bundles (paperclip-port: Anthropic prompt-cache reuse) -----

export const promptBundles = sqliteTable('prompt_bundles', {
  bundleKey: text('bundle_key').primaryKey(),
  cwd: text('cwd').notNull(),
  claudeSessionId: text('claude_session_id'),
  systemPromptHash: text('system_prompt_hash').notNull(),
  allowedToolsHash: text('allowed_tools_hash').notNull(),
  model: text('model').notNull(),
  hitCount: integer('hit_count').notNull().default(0),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
export type PromptBundle = typeof promptBundles.$inferSelect;
export type NewPromptBundle = typeof promptBundles.$inferInsert;

// ----- run summaries (paperclip-port: cross-run continuation context) -----

export const runSummaries = sqliteTable('run_summaries', {
  runId: text('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  summaryMd: text('summary_md').notNull(),
  mode: text('mode'),
  tokensTotal: integer('tokens_total').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
export type RunSummary = typeof runSummaries.$inferSelect;
export type NewRunSummary = typeof runSummaries.$inferInsert;

// ----- dod_criteria (v1.8: Definition of Done) -----
//
// Per-project list of acceptance criteria. Each row is one user-declared
// "this must work" gate. The runtime-verifier agent produces evidence that
// each criterion is satisfied (smoke probe, Playwright test, or human
// approval); the release-gate node refuses to merge until every criterion
// has evidence.

export const dodKindValues = ['smoke', 'e2e', 'manual'] as const;
export type DodKind = (typeof dodKindValues)[number];

/**
 * Storage shape for `dod_criteria.specJson`. The shape varies per kind:
 *   - smoke: `{ url: string; expectedStatus?: number; timeoutMs?: number }`
 *   - e2e:   `{ testFile: string; testName?: string }`
 *   - manual: `{ note?: string }`
 * We keep it as a discriminated union at the Zod layer (see plan.ts), but
 * the SQL column is a generic JSON blob.
 */
export type DodSpecJson = Record<string, unknown>;

export const dodCriteria = sqliteTable('dod_criteria', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  kind: text('kind', { enum: dodKindValues }).notNull(),
  specJson: text('spec_json', { mode: 'json' }).$type<DodSpecJson>().notNull(),
  position: integer('position').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type DodCriterion = typeof dodCriteria.$inferSelect;
export type NewDodCriterion = typeof dodCriteria.$inferInsert;

// ----- runtime_reports (v1.8: runtime verification per run) -----
//
// One row per runtime-verify pass against a run's result branch. `verdict`
// is the top-level decision the release-gate consumes; the per-component
// flags (boot_ok, e2e_ok) are surfaced in the dashboard so the user sees
// which gate failed without opening the markdown.

export const runtimeReportVerdictValues = ['pass', 'fail', 'skipped', 'error'] as const;
export type RuntimeReportVerdict = (typeof runtimeReportVerdictValues)[number];

export interface RuntimeEvidenceJson {
  /** Relative paths in the result branch to screenshots or trace files. */
  artifacts?: string[];
  /** Optional Playwright JSON-reporter summary path. */
  playwrightReport?: string;
  /** Optional console/network error counts captured during boot-smoke. */
  consoleErrors?: number;
  networkErrors?: number;
}

export const runtimeReports = sqliteTable('runtime_reports', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  verdict: text('verdict', { enum: runtimeReportVerdictValues }).notNull(),
  bootOk: integer('boot_ok', { mode: 'boolean' }).notNull().default(false),
  e2eOk: integer('e2e_ok', { mode: 'boolean' }).notNull().default(false),
  dodPassed: integer('dod_passed').notNull().default(0),
  dodTotal: integer('dod_total').notNull().default(0),
  reportMd: text('report_md'),
  evidenceJson: text('evidence_json', { mode: 'json' }).$type<RuntimeEvidenceJson>(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type RuntimeReport = typeof runtimeReports.$inferSelect;
export type NewRuntimeReport = typeof runtimeReports.$inferInsert;

// ----- project_briefs (v1.9: interview-agent output) -----
//
// One row per project (UNIQUE index on project_id). Populated by the
// requirements-interviewer agent during the Brief phase. `completenessScore`
// rises as the interviewer extracts more facts; `briefReady` flips to true
// when the interviewer or the user explicitly finalises. The planner reads
// this row + the docs/PRD.md file at `prdPath` and refuses to plan when
// `briefReady` is false (override flag exists for power-users).

export const projectBriefs = sqliteTable('project_briefs', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  targetAudience: text('target_audience'),
  successCriteria: text('success_criteria'),
  designPrefs: text('design_prefs'),
  platform: text('platform'),
  constraints: text('constraints'),
  deadline: integer('deadline', { mode: 'timestamp_ms' }),
  completenessScore: integer('completeness_score').notNull().default(0),
  prdPath: text('prd_path'),
  briefReady: integer('brief_ready', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type ProjectBrief = typeof projectBriefs.$inferSelect;
export type NewProjectBrief = typeof projectBriefs.$inferInsert;

// ----- change_requests (v1.9: visual-edit + text-mode iteration queue) -----
//
// User-authored "change this region" or "add this feature" notes captured
// from the Preview tab. The user accumulates a queue of pending requests and
// then clicks "Run Iteration", at which point a new run is created with
// kind='iteration' and the relevant change_requests are linked via runId
// and flipped to 'in-run'. After the run the runtime-verifier / lead agent
// marks each one 'done' or 'dismissed'.

export const changeRequestStatusValues = ['pending', 'in-run', 'done', 'dismissed'] as const;
export type ChangeRequestStatus = (typeof changeRequestStatusValues)[number];

export const changeRequestSourceValues = ['visual', 'text'] as const;
export type ChangeRequestSource = (typeof changeRequestSourceValues)[number];

/**
 * Storage shape for `change_requests.rectJson`. Captured from the inspector
 * script via the iframe DOMRect. Width/height are pixels at the time of
 * capture (the preview viewport may have changed since).
 */
export interface ChangeRequestRectJson {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const changeRequests = sqliteTable('change_requests', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  // Nullable: a pending request has no run yet. Set when the iteration run is
  // started. SET NULL on cascade so the request survives a run-deletion (the
  // user might still want the note even if the run is gone).
  runId: text('run_id'),
  status: text('status', { enum: changeRequestStatusValues }).notNull().default('pending'),
  source: text('source', { enum: changeRequestSourceValues }).notNull(),
  selector: text('selector'),
  rectJson: text('rect_json', { mode: 'json' }).$type<ChangeRequestRectJson>(),
  screenshotPath: text('screenshot_path'),
  userPrompt: text('user_prompt').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
});
export type ChangeRequest = typeof changeRequests.$inferSelect;
export type NewChangeRequest = typeof changeRequests.$inferInsert;

// ----- project_states (v1.9: post-run snapshot of where the project stands) -----
//
// After every successful run the runtime-verifier (or future lead agent)
// writes docs/project-state.md inside the managed repo. We persist one row
// per snapshot here so iteration planners can read the most recent state
// without re-parsing markdown and so the UI can render a "where we stand"
// card. `stateMd` is the relative path to the markdown inside the result
// branch; the other columns are extracted into JSON arrays of short bullets.

export const projectStates = sqliteTable('project_states', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id'),
  stateMd: text('state_md'),
  completedFeatures: text('completed_features', { mode: 'json' }).$type<string[]>().notNull(),
  openTodos: text('open_todos', { mode: 'json' }).$type<string[]>().notNull(),
  knownIssues: text('known_issues', { mode: 'json' }).$type<string[]>().notNull(),
  architectureSnapshot: text('architecture_snapshot', { mode: 'json' }).$type<unknown>(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type ProjectState = typeof projectStates.$inferSelect;
export type NewProjectState = typeof projectStates.$inferInsert;

// ----- project_agent_overrides (v1.9: per-project role customisation) -----
//
// One row per (project, role) where the user wants to deviate from the
// shared agent definition in /agents/*.md. Additive — base prompt is still
// loaded and the override tail is appended. Empty rows (all NULL fields)
// are meaningless; callers enforce. `memoryNamespace` lets one role share a
// memory bucket across all projects, while another role keeps its bucket
// per-project — the org-chart UI exposes this.

export const projectAgentOverrides = sqliteTable('project_agent_overrides', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  model: text('model', { enum: agentModelValues }),
  extraSystemPrompt: text('extra_system_prompt'),
  extraAllowedTools: text('extra_allowed_tools', { mode: 'json' }).$type<string[]>(),
  memoryNamespace: text('memory_namespace'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type ProjectAgentOverride = typeof projectAgentOverrides.$inferSelect;
export type NewProjectAgentOverride = typeof projectAgentOverrides.$inferInsert;

// ----- lead_notes (v2.0.0: lead agent — Theo — synthesis output) -----
//
// One row per `POST /api/projects/:id/lead/tick`. Captures the lead agent's
// full markdown narrative (`summaryMd`) plus a structured short-form
// (`decisionsJson`) the dashboard can render at a glance: which role should
// pick up next, what's blocking progress, and whether the lead recommends
// continuing, replanning, or waiting for the user. `runId` is the run the
// tick was scoped to (or null for a tick that wasn't run-bound).
// `triggeredRunId` is wired for the v2.1 auto-spawn replan path; v2.0 always
// leaves it null and emits replan recommendations only.

export type LeadRecommendedAction = 'continue' | 'replan' | 'wait-for-user';

export interface LeadDecisionsJson {
  nextRole?: string | null;
  reasoning?: string | null;
  blockers?: string[];
  recommendedAction?: LeadRecommendedAction;
}

export const leadNotes = sqliteTable('lead_notes', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id'),
  summaryMd: text('summary_md').notNull(),
  decisionsJson: text('decisions_json', { mode: 'json' }).$type<LeadDecisionsJson>(),
  triggeredRunId: text('triggered_run_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type LeadNote = typeof leadNotes.$inferSelect;
export type NewLeadNote = typeof leadNotes.$inferInsert;

// ----- rateWindows -----
export const rateWindows = sqliteTable('rate_windows', {
  id: text('id').primaryKey(),
  detectedAt: integer('detected_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  resetAt: integer('reset_at', { mode: 'timestamp_ms' }),
  source: text('source').notNull(),
});
export type RateWindow = typeof rateWindows.$inferSelect;
export type NewRateWindow = typeof rateWindows.$inferInsert;
