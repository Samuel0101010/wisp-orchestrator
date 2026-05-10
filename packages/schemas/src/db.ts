import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

// ----- projects -----
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  goal: text('goal').notNull(),
  repoPath: text('repo_path').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

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

export const plans = sqliteTable('plans', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  dagJson: text('dag_json', { mode: 'json' }).$type<unknown>().notNull(),
  status: text('status', { enum: planStatusValues }).notNull(),
  // Nullable for root plans; set to the predecessor's id when this is a QA-replan child.
  // FK lives in the SQL migration (self-referential Drizzle .references() has ordering issues).
  parentPlanId: text('parent_plan_id'),
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
  budgetMinutes: integer('budget_minutes').notNull(),
  budgetTurns: integer('budget_turns').notNull(),
  maxParallel: integer('max_parallel').notNull(),
  tokensInTotal: integer('tokens_in_total').notNull().default(0),
  tokensOutTotal: integer('tokens_out_total').notNull().default(0),
  turnsTotal: integer('turns_total').notNull().default(0),
  pausedReason: text('paused_reason', { enum: runPausedReasonValues }),
  resumeAt: integer('resume_at', { mode: 'timestamp_ms' }),
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
