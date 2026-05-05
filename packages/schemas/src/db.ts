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
  role: 'architect' | 'developer' | 'qa';
  model: string;
  allowedTools: string[];
  systemPrompt: string;
}
export interface TeamRolesJson {
  architect: AgentSpecLite;
  developer: AgentSpecLite;
  qa: AgentSpecLite;
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

export const taskRoleValues = ['architect', 'developer', 'qa'] as const;
export type TaskRole = (typeof taskRoleValues)[number];

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').notNull(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    role: text('role', { enum: taskRoleValues }).notNull(),
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

export const runPausedReasonValues = ['rate-limit', 'user', 'shutdown', 'consecutive-failures'] as const;
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
