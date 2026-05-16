/**
 * Append a runtime-verifier node to a planner-produced Plan.
 *
 * The planner LLM doesn't know about Definition-of-Done or v1.8's release-gate;
 * it just emits the build/QA DAG it was prompted to emit. Rather than retrain
 * every team's planner prompt, we post-process: if the project has
 * `runtime_verify_enabled=true`, we splice an extra role + node onto the end of
 * the generated plan that depends on every terminal node.
 *
 * Why post-processing instead of prompt engineering:
 *   - Deterministic — never depends on the LLM remembering the role.
 *   - Cheap — pure-function transform on the already-validated Plan.
 *   - Reversible — turn the project flag off and new plans go back to the
 *     v1.7 shape without prompt edits.
 *
 * If the plan already has a runtime-verifier role (e.g. a hand-edited plan
 * from the PlanEditor UI, or a replan that copied the parent's team), this
 * function returns the input unchanged. Idempotent.
 *
 * The team-role cap is 8 (see planSchema). When injecting would exceed it
 * we return the plan unchanged and log; the gate then degrades to the
 * legacy path (no verifier in plan → no DoD enforcement for that plan).
 */
import type { DodCriterion, Plan } from '@wisp/schemas';
import { planSchema } from '@wisp/schemas';
import { planHasRuntimeVerifier } from './runtime-report-loader.js';
import { RUNTIME_VERIFIER_ROLE, buildRuntimeVerifyNode } from './runtime-verifier.js';

export interface InjectRuntimeVerifierArgs {
  plan: Plan;
  dodCriteria: DodCriterion[];
  detected?: { devCommand: string | null; probeUrl: string | null; type: string };
  /** Override node id (defaults to `n-runtime-verify`). Existing planners
   *  already use n-prefixed ids, but a few hand-written tests use bare names. */
  nodeId?: string;
}

export interface InjectionResult {
  plan: Plan;
  /** Why we made the call, surfaced in audit events so the user can see
   *  exactly what changed when they open a plan in the editor. */
  reason: 'injected' | 'already-present' | 'team-cap-reached' | 'no-terminal-nodes' | 'plan-empty';
}

/** Terminal nodes = nodes that nothing else lists in its `deps`. */
function findTerminalNodeIds(plan: Plan): string[] {
  const referenced = new Set<string>();
  for (const n of plan.nodes) {
    for (const d of n.deps) referenced.add(d);
  }
  return plan.nodes.filter((n) => !referenced.has(n.id)).map((n) => n.id);
}

export function injectRuntimeVerifier(args: InjectRuntimeVerifierArgs): InjectionResult {
  if (planHasRuntimeVerifier(args.plan)) {
    return { plan: args.plan, reason: 'already-present' };
  }
  if (args.plan.nodes.length === 0) {
    return { plan: args.plan, reason: 'plan-empty' };
  }
  if (args.plan.team.roles.length >= 8) {
    return { plan: args.plan, reason: 'team-cap-reached' };
  }
  const terminals = findTerminalNodeIds(args.plan);
  if (terminals.length === 0) {
    // Shouldn't happen for a validated DAG (cycles would've been rejected),
    // but defending so a future planner bug doesn't crash the injector.
    return { plan: args.plan, reason: 'no-terminal-nodes' };
  }

  const verifyNode = buildRuntimeVerifyNode({
    id: args.nodeId ?? 'n-runtime-verify',
    deps: terminals,
    dodCriteria: args.dodCriteria,
    detected: args.detected,
  });

  const newEdges = terminals.map((from) => ({ from, to: verifyNode.id }));

  const out: Plan = {
    goal: args.plan.goal,
    team: { roles: [...args.plan.team.roles, RUNTIME_VERIFIER_ROLE] },
    nodes: [...args.plan.nodes, verifyNode],
    edges: [...args.plan.edges, ...newEdges],
  };

  // Re-validate before returning. If our transform broke the shape somehow,
  // fail closed by handing back the original plan untouched — better to skip
  // verification than persist an invalid Plan that startRun will reject.
  const safe = planSchema.safeParse(out);
  if (!safe.success) {
    return { plan: args.plan, reason: 'plan-empty' };
  }

  return { plan: out, reason: 'injected' };
}
