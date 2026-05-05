export { runClaude, ClaudeSubprocess } from './subprocess.js';
export type { RunClaudeOpts } from './subprocess.js';

export { SubprocessPool } from './pool.js';
export type { SubprocessPoolOpts, SubprocessRunner } from './pool.js';

export { detectRateLimit } from './rate-limit.js';
export type { RateLimitHit } from './rate-limit.js';

export { probeSubscriptionAuth } from './auth.js';
export type { AuthProbeResult, ProbeOpts } from './auth.js';

export { addWorktree, removeWorktree, listWorktrees, computeWorktreePath } from './worktree.js';
export type {
  AddWorktreeOpts,
  RemoveWorktreeOpts,
  ListWorktreesOpts,
  WorktreeEntry,
} from './worktree.js';

export { runVerification } from './verification.js';
export type {
  SuccessCriteria,
  VerificationResult,
  VerificationFailure,
  VerificationKind,
  RunVerificationOpts,
} from './verification.js';

export { Walker, composeTaskPrompt } from './walker.js';
export type {
  WalkerDeps,
  WalkerStatus,
  StartArgs,
  BudgetConfig,
  InitialWalkerState,
  TaskState,
  TaskStatusValue,
  RunState,
  WorktreeAdapter,
} from './walker.js';
