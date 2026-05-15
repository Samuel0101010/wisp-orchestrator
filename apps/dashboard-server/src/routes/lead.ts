/**
 * Lead routes — v2.0.0 Phase 8 (Lead Agent · Theo).
 *
 *   POST   /api/projects/:projectId/lead/tick           — run a synthesis tick
 *   GET    /api/projects/:projectId/lead/notes          — list newest-first
 *   GET    /api/projects/:projectId/lead/notes/:id      — single row
 *   DELETE /api/projects/:projectId/lead/notes/:id      — remove
 *
 * V1 is manual-tick only. Auto-spawn replans on `recommendedAction='replan'`
 * land in v2.1; today we just emit the recommendation in the note.
 */

import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { leadNotes, projects } from '@agent-harness/schemas';
import { db } from '../db/index.js';
import { wrap } from './wrap.js';
import { runLeadTick, type RunLeadTickArgs } from '../orchestrator/lead-runner.js';

export interface LeadRouterDeps {
  /** Test seam — production passes the real runLeadTick. */
  runTick?: typeof runLeadTick;
  /** Test seam — forwarded to runLeadTick when defaultRunTick is in use. */
  turnImpl?: RunLeadTickArgs['turnImpl'];
}

export function createLeadRouter(deps: LeadRouterDeps = {}): FastifyPluginAsync {
  const runTick = deps.runTick ?? runLeadTick;

  const router: FastifyPluginAsync = async (app) => {
    app.post(
      '/api/projects/:projectId/lead/tick',
      wrap(async (req, reply) => {
        const params = z.object({ projectId: z.string().min(1) }).parse(req.params);
        const body = z
          .object({ runId: z.string().min(1).optional() })
          .optional()
          .parse(req.body ?? {});

        const project = await db
          .select()
          .from(projects)
          .where(eq(projects.id, params.projectId))
          .get();
        if (!project) {
          reply.code(404);
          return { error: 'project not found' };
        }
        if (!project.leadEnabled) {
          reply.code(412);
          return {
            error: 'lead_disabled',
            message:
              'Lead agent is disabled for this project. Set leadEnabled=true via PATCH /api/projects/:id.',
          };
        }

        const result = await runTick({
          projectId: params.projectId,
          runId: body?.runId,
          turnImpl: deps.turnImpl,
        });
        return result;
      }),
    );

    app.get(
      '/api/projects/:projectId/lead/notes',
      wrap(async (req, reply) => {
        const params = z.object({ projectId: z.string().min(1) }).parse(req.params);
        const query = z
          .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
          .parse(req.query ?? {});
        const project = await db
          .select()
          .from(projects)
          .where(eq(projects.id, params.projectId))
          .get();
        if (!project) {
          reply.code(404);
          return { error: 'project not found' };
        }
        const rows = await db
          .select()
          .from(leadNotes)
          .where(eq(leadNotes.projectId, params.projectId))
          .orderBy(desc(leadNotes.createdAt))
          .limit(query.limit ?? 10)
          .all();
        return rows;
      }),
    );

    app.get(
      '/api/projects/:projectId/lead/notes/:id',
      wrap(async (req, reply) => {
        const params = z
          .object({ projectId: z.string().min(1), id: z.string().min(1) })
          .parse(req.params);
        const row = await db
          .select()
          .from(leadNotes)
          .where(and(eq(leadNotes.id, params.id), eq(leadNotes.projectId, params.projectId)))
          .get();
        if (!row) {
          reply.code(404);
          return { error: 'lead note not found' };
        }
        return row;
      }),
    );

    app.delete(
      '/api/projects/:projectId/lead/notes/:id',
      wrap(async (req, reply) => {
        const params = z
          .object({ projectId: z.string().min(1), id: z.string().min(1) })
          .parse(req.params);
        const row = await db
          .select()
          .from(leadNotes)
          .where(and(eq(leadNotes.id, params.id), eq(leadNotes.projectId, params.projectId)))
          .get();
        if (!row) {
          reply.code(404);
          return { error: 'lead note not found' };
        }
        await db.delete(leadNotes).where(eq(leadNotes.id, params.id)).run();
        reply.code(204);
        return null;
      }),
    );
  };
  return router;
}

export const leadRoutes: FastifyPluginAsync = createLeadRouter();
