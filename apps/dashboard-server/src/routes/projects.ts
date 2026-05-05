import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { plans, projects, runs } from '@agent-harness/schemas';
import { db } from '../db/index.js';
import { wrap } from './wrap.js';

const createProjectSchema = z.object({
  name: z.string().min(1),
  goal: z.string().min(1),
  repoPath: z.string().min(1),
});

export const projectRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/projects',
    wrap(async () => {
      const rows = await db.select().from(projects).all();
      return rows;
    }),
  );

  app.post(
    '/api/projects',
    wrap(async (req, reply) => {
      const body = createProjectSchema.parse(req.body);
      const row = {
        id: randomUUID(),
        name: body.name,
        goal: body.goal,
        repoPath: body.repoPath,
        createdAt: new Date(),
      };
      await db.insert(projects).values(row).run();
      reply.code(201);
      return row;
    }),
  );

  app.get(
    '/api/projects/:id',
    wrap(async (req, reply) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      const row = await db.select().from(projects).where(eq(projects.id, params.id)).get();
      if (!row) {
        reply.code(404);
        return { error: 'project not found' };
      }
      return row;
    }),
  );

  app.get(
    '/api/projects/:projectId/runs',
    wrap(async (req, reply) => {
      const params = z.object({ projectId: z.string().min(1) }).parse(req.params);
      const project = await db
        .select()
        .from(projects)
        .where(eq(projects.id, params.projectId))
        .get();
      if (!project) {
        reply.code(404);
        return { error: 'project not found' };
      }
      // Find all plans of this project, then runs of those plans, ordered by startedAt desc.
      const planRows = await db
        .select({ id: plans.id })
        .from(plans)
        .where(eq(plans.projectId, params.projectId))
        .all();
      if (planRows.length === 0) return [];
      const planIds = new Set(planRows.map((p) => p.id));
      const runRows = await db
        .select({
          id: runs.id,
          planId: runs.planId,
          status: runs.status,
          outcome: runs.outcome,
          startedAt: runs.startedAt,
          endedAt: runs.endedAt,
          pausedReason: runs.pausedReason,
          resumeAt: runs.resumeAt,
        })
        .from(runs)
        .orderBy(desc(runs.startedAt))
        .all();
      return runRows.filter((r) => planIds.has(r.planId));
    }),
  );
};
