/**
 * Append an optional lead-checkpoint node to a planner-produced Plan.
 *
 * v2.0.0 Phase 8. Mirrors `inject-runtime-verifier.ts`: when the project has
 * `leadEnabled=true`, splice a `role: 'lead'` node onto the end of the plan
 * that depends on every terminal node. The lead synthesises the project's
 * state, decides whether to continue, replan, or wait for the user, and
 * emits a structured `<<LEAD_DECISION>>` directive.
 *
 * Idempotent: re-running the injection on an already-injected plan is a
 * no-op. Refuses when the team is already at the 8-role cap (the cap lives
 * in planSchema). Refuses on empty plans or plans with no terminals.
 *
 * The injection is gated by the caller — `plans.ts` only calls this when
 * `project.leadEnabled === true`. Reversible by flipping the flag back.
 */
import type { AgentSpec, Plan, TaskNode } from '@wisp/schemas';
import { planSchema } from '@wisp/schemas';

export const LEAD_ROLE: AgentSpec = {
  role: 'lead',
  model: 'opus',
  allowedTools: ['Read', 'Grep', 'Glob'],
  systemPrompt: [
    'You are Theo — Team Lead. You synthesise project state at the end of a run.',
    'Read the prior task hand-offs and the current state of the repo.',
    'Decide whether the team should continue, replan, or wait for the user.',
    'Emit exactly one <<LEAD_DECISION>>{...}<<END>> directive at the end of your reply.',
    'Do not write code. Do not edit files. Read-only role.',
  ].join('\n'),
};

const LEAD_NODE_ID = 'n-lead-checkpoint';
const DEFAULT_LEAD_MAX_TURNS = 20;
const TEAM_ROLE_CAP = 8;

export interface InjectLeadCheckpointArgs {
  plan: Plan;
  /** Override node id (defaults to `n-lead-checkpoint`). */
  nodeId?: string;
}

export interface InjectLeadCheckpointResult {
  plan: Plan;
  reason: 'injected' | 'already-present' | 'team-cap-reached' | 'no-terminal-nodes' | 'plan-empty';
}

function planHasLead(plan: Plan): boolean {
  return (
    plan.team.roles.some((r) => r.role === 'lead') || plan.nodes.some((n) => n.role === 'lead')
  );
}

function findTerminalNodeIds(plan: Plan): string[] {
  const referenced = new Set<string>();
  for (const n of plan.nodes) {
    for (const d of n.deps) referenced.add(d);
  }
  return plan.nodes.filter((n) => !referenced.has(n.id)).map((n) => n.id);
}

function buildLeadCheckpointNode(args: { id: string; deps: string[] }): TaskNode {
  return {
    id: args.id,
    role: 'lead',
    prompt:
      "Synthesize the project's state. Decide whether to continue, replan, or wait for the user. Emit one <<LEAD_DECISION>>{...}<<END>> directive at the end of your reply.",
    deps: args.deps,
    successCriteria: {},
    maxTurns: DEFAULT_LEAD_MAX_TURNS,
  };
}

export function injectLeadCheckpoint(args: InjectLeadCheckpointArgs): InjectLeadCheckpointResult {
  if (planHasLead(args.plan)) {
    return { plan: args.plan, reason: 'already-present' };
  }
  if (args.plan.nodes.length === 0) {
    return { plan: args.plan, reason: 'plan-empty' };
  }
  if (args.plan.team.roles.length >= TEAM_ROLE_CAP) {
    return { plan: args.plan, reason: 'team-cap-reached' };
  }
  const terminals = findTerminalNodeIds(args.plan);
  if (terminals.length === 0) {
    return { plan: args.plan, reason: 'no-terminal-nodes' };
  }

  const leadNode = buildLeadCheckpointNode({
    id: args.nodeId ?? LEAD_NODE_ID,
    deps: terminals,
  });

  const newEdges = terminals.map((from) => ({ from, to: leadNode.id }));

  const out: Plan = {
    goal: args.plan.goal,
    team: { roles: [...args.plan.team.roles, LEAD_ROLE] },
    nodes: [...args.plan.nodes, leadNode],
    edges: [...args.plan.edges, ...newEdges],
  };

  // Re-validate before returning. If our transform broke the shape, hand
  // back the original plan untouched so the caller still has a valid Plan.
  const safe = planSchema.safeParse(out);
  if (!safe.success) {
    return { plan: args.plan, reason: 'plan-empty' };
  }
  return { plan: out, reason: 'injected' };
}
