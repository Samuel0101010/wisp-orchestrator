/**
 * Append a wire-up node to a planner-produced Plan.
 *
 * Mirror of inject-runtime-verifier / inject-lead-checkpoint. The wire-up
 * role reconciles cross-file inconsistencies that arise when the WISP
 * orchestrator runs multiple core-dev tasks in parallel worktrees (App.tsx
 * not updated to mount new components, missing Tauri trait imports, etc.).
 *
 * The injection runs BEFORE inject-runtime-verifier in the plans.ts call
 * chain so wire-up sits between core-dev leaves and the verifier; the
 * verifier then sees the reconciled tree rather than the raw parallel
 * output.
 *
 * Re-export of the underlying function from wire-up.ts so the call sites
 * stay parallel to inject-runtime-verifier.ts. The implementation itself
 * (with the splice logic + role definition) lives in wire-up.ts because
 * the role config is non-trivial and tested in isolation.
 */

export { injectWireUp, buildWireUpNode, planHasWireUp, WIRE_UP_ROLE } from './wire-up.js';
export type { InjectWireUpArgs, InjectWireUpResult } from './wire-up.js';
