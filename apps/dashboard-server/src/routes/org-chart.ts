/**
 * Org-chart (v1.13 Phase 5) — per-project team visualisation.
 *
 * The org-chart endpoint shapes the team's roles + the most-recent plan's
 * DAG into a node/edge structure the dashboard renders via ReactFlow. Every
 * role is a node; edges are derived at role-granularity by collapsing the
 * plan's node-level edges down to (from-role → to-role) pairs and
 * deduplicating. Per-role live status is the max-severity status across the
 * latest run's tasks for that role (failed > running > done > idle).
 *
 * Returns empty `roles` (not 404) when the project has no team yet — the
 * UI can render a "no team yet" empty state without juggling 404 plumbing.
 */
import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  agents as agentsTable,
  plans,
  projects,
  runs,
  tasks,
  teams,
  safeParsePlan,
  type AgentModel,
  type Plan,
} from '@agent-harness/schemas';
import { db } from '../db/index.js';
import { wrap } from './wrap.js';

interface OrgChartRole {
  role: string;
  displayName: string;
  model: AgentModel;
  avatarUrl: string | null;
  color: string | null;
  description: string | null;
  allowedToolsCount: number;
  seedKey: string | null;
  agentId: string | null;
}

interface OrgChartEdge {
  from: string;
  to: string;
  kind: 'plan-dep' | 'handoff';
}

type LiveRoleStatus = 'idle' | 'working' | 'done' | 'failed';

interface OrgChartLiveStatus {
  role: string;
  status: LiveRoleStatus;
  lastTaskId?: string;
  lastUpdatedAt?: number;
}

interface OrgChartResponse {
  roles: OrgChartRole[];
  edges: OrgChartEdge[];
  liveStatus: OrgChartLiveStatus[];
  latestPlanId: string | null;
  latestRunId: string | null;
}

interface StoredRolesShape {
  roles: Array<{
    role: string;
    model: AgentModel;
    allowedTools: string[];
    systemPrompt: string;
    agentId?: string | null;
  }>;
}

function safeRoles(rolesJson: unknown): StoredRolesShape['roles'] | null {
  if (!rolesJson || typeof rolesJson !== 'object') return null;
  const raw = (rolesJson as { roles?: unknown }).roles;
  if (!Array.isArray(raw)) return null;
  return raw as StoredRolesShape['roles'];
}

/**
 * Collapse a Plan's node-level edges down to role-level edges, deduplicated.
 * Each edge in the plan references node ids; we look up each node's role and
 * emit one edge per unique (fromRole, toRole) pair. Self-loops at the role
 * level (role A → role A) are dropped — they carry no chart signal.
 */
function buildRoleEdgesFromPlan(plan: Plan): OrgChartEdge[] {
  const nodeRoleById = new Map<string, string>();
  for (const n of plan.nodes) nodeRoleById.set(n.id, n.role);
  const seen = new Set<string>();
  const edges: OrgChartEdge[] = [];
  for (const e of plan.edges) {
    const fromRole = nodeRoleById.get(e.from);
    const toRole = nodeRoleById.get(e.to);
    if (!fromRole || !toRole) continue;
    if (fromRole === toRole) continue;
    const key = `${fromRole}${toRole}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: fromRole, to: toRole, kind: 'plan-dep' });
  }
  return edges;
}

/**
 * Aggregate task statuses per-role into a single bucket. The hierarchy:
 *   failed   > running (→ 'working') > done > anything else (→ 'idle')
 * If at least one task is failed we surface 'failed' so the chart can flag
 * the broken role; otherwise running beats done beats idle.
 */
function aggregateLiveStatus(
  roleList: string[],
  taskRows: Array<{ id: string; role: string; status: string }>,
): OrgChartLiveStatus[] {
  const byRole = new Map<string, { status: LiveRoleStatus; lastTaskId?: string }>();
  for (const role of roleList) byRole.set(role, { status: 'idle' });
  for (const t of taskRows) {
    const cur = byRole.get(t.role);
    if (!cur) continue;
    let next: LiveRoleStatus = cur.status;
    if (t.status === 'failed') next = 'failed';
    else if (t.status === 'running' && cur.status !== 'failed') next = 'working';
    else if (t.status === 'done' && cur.status !== 'failed' && cur.status !== 'working')
      next = 'done';
    if (next !== cur.status) {
      byRole.set(t.role, { status: next, lastTaskId: t.id });
    }
  }
  return roleList.map((role) => {
    const v = byRole.get(role) ?? { status: 'idle' as LiveRoleStatus };
    const entry: OrgChartLiveStatus = { role, status: v.status };
    if (v.lastTaskId) entry.lastTaskId = v.lastTaskId;
    return entry;
  });
}

export const orgChartRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/projects/:projectId/org-chart',
    wrap(async (req, reply) => {
      const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);

      const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) {
        reply.code(404);
        return { error: 'project not found' };
      }

      const teamRow = await db.select().from(teams).where(eq(teams.projectId, projectId)).get();
      const roleSpecs = teamRow ? safeRoles(teamRow.rolesJson) : null;

      const emptyResponse: OrgChartResponse = {
        roles: [],
        edges: [],
        liveStatus: [],
        latestPlanId: null,
        latestRunId: null,
      };
      if (!roleSpecs || roleSpecs.length === 0) {
        return emptyResponse;
      }

      // Hydrate any linked agents in one query.
      const agentIds = roleSpecs
        .map((r) => r.agentId)
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      const agentRows = agentIds.length
        ? await db.select().from(agentsTable).where(inArray(agentsTable.id, agentIds)).all()
        : [];
      const agentById = new Map(agentRows.map((a) => [a.id, a]));

      const roles: OrgChartRole[] = roleSpecs.map((spec) => {
        const agent = spec.agentId ? agentById.get(spec.agentId) : null;
        return {
          role: spec.role,
          displayName: agent?.name ?? spec.role,
          model: (agent?.model ?? spec.model ?? 'sonnet') as AgentModel,
          avatarUrl: agent?.avatarUrl ?? null,
          color: agent?.color ?? null,
          description: agent?.description ?? null,
          allowedToolsCount: Array.isArray(spec.allowedTools) ? spec.allowedTools.length : 0,
          seedKey: agent?.seedKey ?? null,
          agentId: agent?.id ?? null,
        };
      });

      // Latest plan: derive role-level edges from its DAG.
      const latestPlan = await db
        .select()
        .from(plans)
        .where(eq(plans.projectId, projectId))
        .orderBy(desc(plans.id))
        .get();

      let edges: OrgChartEdge[] = [];
      if (latestPlan) {
        const parsed = safeParsePlan(latestPlan.dagJson);
        if (parsed.success) {
          edges = buildRoleEdgesFromPlan(parsed.data);
        }
      }

      // Latest run for this project (across all of its plans) — pick the one
      // with the largest startedAt. Runs whose plan belongs to this project.
      const projectPlanRows = await db
        .select({ id: plans.id })
        .from(plans)
        .where(eq(plans.projectId, projectId))
        .all();
      const projectPlanIds = projectPlanRows.map((r) => r.id);

      let latestRunId: string | null = null;
      let latestPlanIdForRun: string | null = null;
      if (projectPlanIds.length > 0) {
        const runRows = await db
          .select()
          .from(runs)
          .where(inArray(runs.planId, projectPlanIds))
          .all();
        let best: (typeof runRows)[number] | null = null;
        for (const r of runRows) {
          const cur = r.startedAt ? new Date(r.startedAt).getTime() : 0;
          const bestAt = best?.startedAt ? new Date(best.startedAt).getTime() : -1;
          if (cur > bestAt) best = r;
        }
        if (best) {
          latestRunId = best.id;
          latestPlanIdForRun = best.planId;
        }
      }

      const roleList = roles.map((r) => r.role);
      let liveStatus: OrgChartLiveStatus[] = roleList.map((role) => ({ role, status: 'idle' }));
      if (latestRunId && latestPlanIdForRun) {
        const taskRows = await db
          .select({ id: tasks.id, role: tasks.role, status: tasks.status })
          .from(tasks)
          .where(eq(tasks.planId, latestPlanIdForRun))
          .all();
        liveStatus = aggregateLiveStatus(roleList, taskRows);
      }

      const body: OrgChartResponse = {
        roles,
        edges,
        liveStatus,
        latestPlanId: latestPlan?.id ?? null,
        latestRunId,
      };
      // touch `and` to keep import used elsewhere if we extend filters later
      void and;
      return body;
    }),
  );
};
