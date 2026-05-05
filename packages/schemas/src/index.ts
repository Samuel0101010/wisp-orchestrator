// DB tables (Drizzle) — re-exported but the row type for `plans` is renamed
// to avoid colliding with the Zod-derived `Plan` from ./plan.js (the DAG plan).
export {
  projects,
  teams,
  plans,
  tasks,
  runs,
  events,
  checkpoints,
  rateWindows,
  planStatusValues,
  taskStatusValues,
  runStatusValues,
  runOutcomeValues,
  runPausedReasonValues,
} from './db.js';

export type {
  Project,
  NewProject,
  Team as TeamRow,
  NewTeam,
  Plan as PlanRow,
  NewPlan,
  Task,
  NewTask,
  Run,
  NewRun,
  HarnessEventRow,
  NewHarnessEventRow,
  Checkpoint,
  NewCheckpoint,
  RateWindow,
  NewRateWindow,
  PlanStatus,
  TaskStatus,
  TaskRole,
  RunStatus,
  RunOutcome,
  RunPausedReason,
} from './db.js';

// Plan DAG (Zod)
export {
  agentSpecSchema,
  taskNodeSchema,
  edgeSchema,
  teamSchema,
  planSchema,
  successCriteriaSchema,
  parsePlan,
  safeParsePlan,
  validateDag,
} from './plan.js';
export type {
  AgentSpec,
  TaskNode,
  Edge,
  Team,
  Plan,
  SuccessCriteria,
  Role,
  DagValidationResult,
} from './plan.js';

// Events (Zod)
export { harnessEventSchema, parseHarnessEvent, safeParseHarnessEvent } from './events.js';
export type { HarnessEvent, HarnessEventType } from './events.js';

// Team (Zod) — re-export shape helpers; row type is `TeamRow` from db.
export { parseTeam, safeParseTeam } from './team.js';
