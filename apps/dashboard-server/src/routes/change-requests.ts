/**
 * Change-request CRUD (v1.12 Phase 4) — the visual-edit + text-mode queue.
 *
 * A row in `change_requests` is one user note ("change this region to X" or a
 * free-form text instruction) captured from the Preview tab. The user
 * accumulates a queue of `pending` rows and then clicks Run Iteration; the
 * iteration planner consumes them (see plans.ts) and `POST /api/runs` flips
 * the consumed rows to `in-run` (see runs.ts). This router is the bare CRUD
 * surface the dashboard uses to manage the queue.
 *
 * Endpoints
 *   GET    /api/projects/:projectId/change-requests?status=pending
 *   POST   /api/projects/:projectId/change-requests
 *   PATCH  /api/projects/:projectId/change-requests/:id
 *   DELETE /api/projects/:projectId/change-requests/:id
 *
 * Status query is optional; default is `pending`. Returns rows oldest-first
 * so the UI can render the queue in the order the user added entries.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  changeRequests,
  changeRequestStatusValues,
  changeRequestSourceValues,
  projects,
} from '@wisp/schemas';
import { db } from '../db/index.js';
import { wrap } from './wrap.js';

const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const createSchema = z.object({
  source: z.enum(changeRequestSourceValues),
  selector: z.string().min(1).max(1000).optional(),
  rectJson: rectSchema.optional(),
  userPrompt: z.string().min(1).max(4000),
});

const patchSchema = z
  .object({
    status: z.enum(changeRequestStatusValues).optional(),
    userPrompt: z.string().min(1).max(4000).optional(),
  })
  .refine((v) => v.status !== undefined || v.userPrompt !== undefined, {
    message: 'at least one editable field must be provided',
  });

const listQuerySchema = z.object({
  status: z.enum(changeRequestStatusValues).optional(),
});

export const changeRequestRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/projects/:projectId/change-requests',
    wrap(async (req, reply) => {
      const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
      const { status } = listQuerySchema.parse(req.query ?? {});
      const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const effectiveStatus = status ?? 'pending';
      const rows = await db
        .select()
        .from(changeRequests)
        .where(
          and(eq(changeRequests.projectId, projectId), eq(changeRequests.status, effectiveStatus)),
        )
        .orderBy(asc(changeRequests.createdAt))
        .all();
      return rows;
    }),
  );

  app.post(
    '/api/projects/:projectId/change-requests',
    wrap(async (req, reply) => {
      const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
      const body = createSchema.parse(req.body);
      const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const row = {
        id: randomUUID(),
        projectId,
        runId: null,
        status: 'pending' as const,
        source: body.source,
        selector: body.selector ?? null,
        rectJson: body.rectJson ?? null,
        screenshotPath: null,
        userPrompt: body.userPrompt,
        createdAt: new Date(),
        resolvedAt: null,
      };
      await db.insert(changeRequests).values(row).run();
      reply.code(201);
      return row;
    }),
  );

  app.patch(
    '/api/projects/:projectId/change-requests/:id',
    wrap(async (req, reply) => {
      const { projectId, id } = z
        .object({ projectId: z.string().min(1), id: z.string().min(1) })
        .parse(req.params);
      const body = patchSchema.parse(req.body);
      const existing = await db
        .select()
        .from(changeRequests)
        .where(eq(changeRequests.id, id))
        .get();
      if (!existing || existing.projectId !== projectId) {
        reply.code(404);
        return { error: 'change request not found' };
      }
      const update: Record<string, unknown> = {};
      if (body.status !== undefined) update.status = body.status;
      if (body.userPrompt !== undefined) update.userPrompt = body.userPrompt;
      await db.update(changeRequests).set(update).where(eq(changeRequests.id, id)).run();
      const updated = await db.select().from(changeRequests).where(eq(changeRequests.id, id)).get();
      return updated;
    }),
  );

  app.delete(
    '/api/projects/:projectId/change-requests/:id',
    wrap(async (req, reply) => {
      const { projectId, id } = z
        .object({ projectId: z.string().min(1), id: z.string().min(1) })
        .parse(req.params);
      const existing = await db
        .select()
        .from(changeRequests)
        .where(eq(changeRequests.id, id))
        .get();
      if (!existing || existing.projectId !== projectId) {
        reply.code(404);
        return { error: 'change request not found' };
      }
      await db.delete(changeRequests).where(eq(changeRequests.id, id)).run();
      reply.code(204);
      return null;
    }),
  );
};
