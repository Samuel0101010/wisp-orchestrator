/**
 * Project agent-overrides CRUD (v1.14 Phase 6).
 *
 * Each project may carry one override row per role. Overrides are additive
 * to the base agent definition (extra system prompt is appended, extra tools
 * are union'd in, model is swapped when set). The dashboard's OrgChartView
 * surfaces a per-node editor that posts to these endpoints.
 *
 * Endpoints
 *   GET    /api/projects/:projectId/agent-overrides       — list
 *   GET    /api/projects/:projectId/agent-overrides/:role — single or 404
 *   PUT    /api/projects/:projectId/agent-overrides/:role — upsert
 *   DELETE /api/projects/:projectId/agent-overrides/:role — remove
 *
 * The DB enforces UNIQUE on (project_id, role) so PUT is implemented as
 * INSERT ... ON CONFLICT DO UPDATE via Drizzle's `onConflictDoUpdate`.
 */
import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentModelValues, projectAgentOverrides, projects } from '@wisp/schemas';
import { db } from '../db/index.js';
import { wrap } from './wrap.js';

const putBody = z
  .object({
    model: z.enum(agentModelValues).nullable().optional(),
    extraSystemPrompt: z.string().max(8000).nullable().optional(),
    extraAllowedTools: z.array(z.string().min(1).max(120)).max(64).nullable().optional(),
    memoryNamespace: z.string().min(1).max(120).nullable().optional(),
  })
  .refine(
    (v) =>
      v.model !== undefined ||
      v.extraSystemPrompt !== undefined ||
      v.extraAllowedTools !== undefined ||
      v.memoryNamespace !== undefined,
    { message: 'at least one editable field must be provided' },
  );

export const agentOverridesRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/projects/:projectId/agent-overrides',
    wrap(async (req, reply) => {
      const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
      const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const rows = await db
        .select()
        .from(projectAgentOverrides)
        .where(eq(projectAgentOverrides.projectId, projectId))
        .all();
      return rows;
    }),
  );

  app.get(
    '/api/projects/:projectId/agent-overrides/:role',
    wrap(async (req, reply) => {
      const { projectId, role } = z
        .object({ projectId: z.string().min(1), role: z.string().min(1) })
        .parse(req.params);
      const row = await db
        .select()
        .from(projectAgentOverrides)
        .where(
          and(eq(projectAgentOverrides.projectId, projectId), eq(projectAgentOverrides.role, role)),
        )
        .get();
      if (!row) {
        reply.code(404);
        return { error: 'override not found' };
      }
      return row;
    }),
  );

  app.put(
    '/api/projects/:projectId/agent-overrides/:role',
    wrap(async (req, reply) => {
      const { projectId, role } = z
        .object({ projectId: z.string().min(1), role: z.string().min(1) })
        .parse(req.params);
      const body = putBody.parse(req.body);

      const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) {
        reply.code(404);
        return { error: 'project not found' };
      }

      // Upsert: SQLite's INSERT ... ON CONFLICT(project_id, role) DO UPDATE
      // mirrors the UNIQUE index that 0015_agent_overrides.sql installs. We
      // resolve to one row and return it.
      const now = new Date();
      const insertRow = {
        id: randomUUID(),
        projectId,
        role,
        model: body.model ?? null,
        extraSystemPrompt: body.extraSystemPrompt ?? null,
        extraAllowedTools: body.extraAllowedTools ?? null,
        memoryNamespace: body.memoryNamespace ?? null,
        createdAt: now,
        updatedAt: now,
      };
      const updateRow: Record<string, unknown> = { updatedAt: now };
      if (body.model !== undefined) updateRow.model = body.model;
      if (body.extraSystemPrompt !== undefined)
        updateRow.extraSystemPrompt = body.extraSystemPrompt;
      if (body.extraAllowedTools !== undefined)
        updateRow.extraAllowedTools = body.extraAllowedTools;
      if (body.memoryNamespace !== undefined) updateRow.memoryNamespace = body.memoryNamespace;

      await db
        .insert(projectAgentOverrides)
        .values(insertRow)
        .onConflictDoUpdate({
          target: [projectAgentOverrides.projectId, projectAgentOverrides.role],
          set: updateRow,
        })
        .run();

      const row = await db
        .select()
        .from(projectAgentOverrides)
        .where(
          and(eq(projectAgentOverrides.projectId, projectId), eq(projectAgentOverrides.role, role)),
        )
        .get();
      return row;
    }),
  );

  app.delete(
    '/api/projects/:projectId/agent-overrides/:role',
    wrap(async (req, reply) => {
      const { projectId, role } = z
        .object({ projectId: z.string().min(1), role: z.string().min(1) })
        .parse(req.params);
      const existing = await db
        .select()
        .from(projectAgentOverrides)
        .where(
          and(eq(projectAgentOverrides.projectId, projectId), eq(projectAgentOverrides.role, role)),
        )
        .get();
      if (!existing) {
        reply.code(404);
        return { error: 'override not found' };
      }
      await db
        .delete(projectAgentOverrides)
        .where(
          and(eq(projectAgentOverrides.projectId, projectId), eq(projectAgentOverrides.role, role)),
        )
        .run();
      reply.code(204);
      return null;
    }),
  );
};
