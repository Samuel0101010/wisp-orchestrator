import { z } from 'zod';

export const roleEnum = z.enum(['architect', 'developer', 'qa']);
export type Role = z.infer<typeof roleEnum>;

export const agentSpecSchema = z.object({
  role: roleEnum,
  model: z.string().min(1),
  allowedTools: z.array(z.string()),
  systemPrompt: z.string(),
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
  role: roleEnum,
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

export const teamSchema = z.object({
  architect: agentSpecSchema,
  developer: agentSpecSchema,
  qa: agentSpecSchema,
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
