import { z } from 'zod';

// Plain string alias for readability. Validation lives on
// agentSpecSchema.role via the kebab-case regex.
export type Role = string;

export const agentSpecSchema = z.object({
  role: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/, {
      message: 'role must be kebab-case starting with a letter',
    }),
  model: z.enum(['opus', 'sonnet', 'haiku']),
  allowedTools: z.array(z.string()),
  systemPrompt: z.string().min(40).max(4000),
  /**
   * Optional reference to a row in the `agents` registry (Model B). When set,
   * the role inherits the agent's persistent identity for chat threads. The
   * inline model/allowedTools/systemPrompt remain authoritative for the
   * orchestrator (so existing teams keep working unchanged); the agentId is
   * a soft link.
   */
  agentId: z.string().min(1).optional(),
  /** Provenance: 'planner' for planner-emitted roles, 'system' for
   *  harness-injected ones (wire-up, runtime-verifier, lead). Optional so
   *  pre-existing plans keep parsing. */
  origin: z.enum(['planner', 'system']).optional(),
});
export type AgentSpec = z.infer<typeof agentSpecSchema>;

export const successCriteriaSchema = z.object({
  preflight: z.string().optional(),
  build: z.string().optional(),
  test: z.string().optional(),
  lint: z.string().optional(),
  custom: z.string().optional(),
});
export type SuccessCriteria = z.infer<typeof successCriteriaSchema>;

export const taskNodeSchema = z.object({
  id: z.string().min(1),
  role: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/),
  /** Human-readable task title for the UI. Optional so pre-existing plans
   *  keep parsing — `deriveTaskTitle` provides the display fallback. Must be
   *  declared here because PATCH/lock routes round-trip dagJson through
   *  planSchema, which strips unknown keys. */
  title: z.string().min(1).max(120).optional(),
  origin: z.enum(['planner', 'system']).optional(),
  prompt: z.string(),
  deps: z.array(z.string()),
  successCriteria: successCriteriaSchema,
  maxTurns: z.number().int().positive(),
});
export type TaskNode = z.infer<typeof taskNodeSchema>;

export const edgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type Edge = z.infer<typeof edgeSchema>;

/**
 * Hard ceiling on the number of roles in a team. This is the absolute maximum
 * the schema accepts and includes any auto-injected system roles (wire-up,
 * runtime-verifier, lead). The user-pickable cap in the Team Builder is lower
 * (it reserves headroom for those injected roles) — see `MAX_ROLES` there.
 * Single source of truth: the orchestrator injection guards import this too,
 * so the cap can never drift across the codebase.
 */
export const MAX_TEAM_ROLES = 16;

export const teamSchema = z
  .object({
    roles: z.array(agentSpecSchema).min(1).max(MAX_TEAM_ROLES),
  })
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    for (const r of t.roles) {
      if (seen.has(r.role)) {
        ctx.addIssue({ code: 'custom', message: `duplicate role: ${r.role}` });
      }
      seen.add(r.role);
    }
  });
export type Team = z.infer<typeof teamSchema>;

export const planSchema = z.object({
  goal: z.string(),
  team: teamSchema,
  nodes: z.array(taskNodeSchema),
  edges: z.array(edgeSchema),
});
export type Plan = z.infer<typeof planSchema>;

export function parsePlan(input: unknown): Plan {
  return planSchema.parse(input);
}

export function safeParsePlan(input: unknown): z.SafeParseReturnType<unknown, Plan> {
  return planSchema.safeParse(input);
}

export type DagValidationResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Structural validation beyond shape:
 *  - all edges reference existing nodes
 *  - all node.deps reference existing nodes
 *  - no cycles
 *  - role enum already enforced by parse
 *  - team slots enforced by parse
 */
export function validateDag(plan: Plan): DagValidationResult {
  const errors: string[] = [];
  const ids = new Set(plan.nodes.map((n) => n.id));

  // duplicate ids
  if (ids.size !== plan.nodes.length) {
    errors.push('duplicate node ids detected');
  }

  // edges reference existing nodes
  for (const e of plan.edges) {
    if (!ids.has(e.from)) {
      errors.push(`edge.from references nonexistent node: ${e.from}`);
    }
    if (!ids.has(e.to)) {
      errors.push(`edge.to references nonexistent node: ${e.to}`);
    }
  }

  // node.deps reference existing nodes
  for (const n of plan.nodes) {
    for (const d of n.deps) {
      if (!ids.has(d)) {
        errors.push(`node "${n.id}" deps references nonexistent node: ${d}`);
      }
    }
  }

  // cycle detection (Kahn's algorithm using deps as adjacency: a depends on its deps)
  // Edge logically: dep -> node. If cycles exist among deps, flag.
  if (errors.length === 0) {
    const indegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const n of plan.nodes) {
      indegree.set(n.id, 0);
      adj.set(n.id, []);
    }
    for (const n of plan.nodes) {
      for (const d of n.deps) {
        adj.get(d)!.push(n.id);
        indegree.set(n.id, (indegree.get(n.id) ?? 0) + 1);
      }
    }
    const queue: string[] = [];
    for (const [id, deg] of indegree) {
      if (deg === 0) queue.push(id);
    }
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      visited++;
      for (const next of adj.get(id) ?? []) {
        const d = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
    if (visited !== plan.nodes.length) {
      errors.push('cycle detected in task DAG');
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}

export type RoleValidationResult =
  | { ok: true }
  | { ok: false; invalidTeamRoles: string[]; invalidNodeRoles: string[] };

/**
 * Every plan.team.roles[].role and plan.nodes[].role must exist in
 * storedTeam.roles[].role. Guards against the planner inventing roles that
 * have no stored agent identity behind them.
 */
export function validatePlanRoles(plan: Plan, storedTeam: Team): RoleValidationResult {
  const known = new Set(storedTeam.roles.map((r) => r.role));
  const invalidTeamRoles = plan.team.roles.map((r) => r.role).filter((role) => !known.has(role));
  const invalidNodeRoles = plan.nodes.map((n) => n.role).filter((role) => !known.has(role));
  if (invalidTeamRoles.length === 0 && invalidNodeRoles.length === 0) {
    return { ok: true };
  }
  return { ok: false, invalidTeamRoles, invalidNodeRoles };
}

const DERIVED_TITLE_MAX = 60;

/**
 * Display title for a task node: explicit `title` wins; otherwise the first
 * non-empty line of the prompt (truncated to 60 chars with a trailing '…');
 * otherwise the node id.
 */
export function deriveTaskTitle(node: Pick<TaskNode, 'id' | 'prompt' | 'title'>): string {
  const explicit = node.title?.trim();
  if (explicit) return explicit;
  const firstLine = node.prompt
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstLine) {
    return firstLine.length > DERIVED_TITLE_MAX
      ? `${firstLine.slice(0, DERIVED_TITLE_MAX)}…`
      : firstLine;
  }
  return node.id;
}
