/**
 * DoD CRUD — Definition-of-Done criteria the user declares per project.
 *
 * One row in `dod_criteria` = one acceptance gate. The runtime-verifier
 * agent reads them out of the DAG node prompt; the release-gate gates
 * auto-merge on whether each has evidence; the dashboard renders them as
 * a checklist on the run view.
 *
 * Endpoints
 *   GET    /api/projects/:projectId/dod          — list (ordered by position)
 *   POST   /api/projects/:projectId/dod          — create
 *   PATCH  /api/projects/:projectId/dod/:dodId   — partial update
 *   DELETE /api/projects/:projectId/dod/:dodId   — remove
 *   PUT    /api/projects/:projectId/dod          — bulk replace (reorder)
 *   GET    /api/runs/:runId/runtime-report       — latest runtime_reports row
 *
 * spec_json is validated per kind via a discriminated union so a stored
 * "smoke" row always has a url etc. The validation is server-only — the
 * SQL column stays a generic JSON blob for forward compatibility.
 */
import type { FastifyPluginAsync } from 'fastify';
import { asc, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dodCriteria, projects, runtimeReports, type DodKind } from '@wisp/schemas';
import { db } from '../db/index.js';
import { wrap } from './wrap.js';

const smokeSpec = z.object({
  url: z.string().min(1),
  expectedStatus: z.number().int().min(100).max(599).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});

const e2eSpec = z.object({
  testFile: z.string().min(1).optional(),
  testName: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});

const manualSpec = z.object({
  note: z.string().min(1).optional(),
});

const dodSpecForKind = (kind: DodKind): z.ZodTypeAny => {
  switch (kind) {
    case 'smoke':
      return smokeSpec;
    case 'e2e':
      return e2eSpec;
    case 'manual':
      return manualSpec;
  }
};

const createSchema = z.object({
  title: z.string().min(1).max(200),
  kind: z.enum(['smoke', 'e2e', 'manual']),
  spec: z.record(z.unknown()),
  position: z.number().int().min(0).optional(),
});

const patchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    kind: z.enum(['smoke', 'e2e', 'manual']).optional(),
    spec: z.record(z.unknown()).optional(),
    position: z.number().int().min(0).optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.kind !== undefined ||
      v.spec !== undefined ||
      v.position !== undefined,
    { message: 'at least one editable field must be provided' },
  );

const bulkReplaceSchema = z.object({
  criteria: z.array(createSchema).max(50),
});

export const dodRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/projects/:projectId/dod',
    wrap(async (req, reply) => {
      const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
      const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const rows = await db
        .select()
        .from(dodCriteria)
        .where(eq(dodCriteria.projectId, projectId))
        .orderBy(asc(dodCriteria.position), asc(dodCriteria.createdAt))
        .all();
      return rows;
    }),
  );

  app.post(
    '/api/projects/:projectId/dod',
    wrap(async (req, reply) => {
      const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
      const body = createSchema.parse(req.body);
      const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const specParsed = dodSpecForKind(body.kind).safeParse(body.spec);
      if (!specParsed.success) {
        reply.code(400);
        return {
          error: 'invalid_spec_for_kind',
          kind: body.kind,
          issues: specParsed.error.issues,
        };
      }
      // Auto-position: insert at the end unless caller specified.
      let position = body.position;
      if (position === undefined) {
        const last = await db
          .select()
          .from(dodCriteria)
          .where(eq(dodCriteria.projectId, projectId))
          .orderBy(desc(dodCriteria.position))
          .get();
        position = (last?.position ?? -1) + 1;
      }
      const row = {
        id: randomUUID(),
        projectId,
        title: body.title,
        kind: body.kind,
        specJson: specParsed.data as Record<string, unknown>,
        position,
        createdAt: new Date(),
      };
      await db.insert(dodCriteria).values(row).run();
      reply.code(201);
      return row;
    }),
  );

  app.patch(
    '/api/projects/:projectId/dod/:dodId',
    wrap(async (req, reply) => {
      const { projectId, dodId } = z
        .object({ projectId: z.string().min(1), dodId: z.string().min(1) })
        .parse(req.params);
      const body = patchSchema.parse(req.body);
      const existing = await db.select().from(dodCriteria).where(eq(dodCriteria.id, dodId)).get();
      if (!existing || existing.projectId !== projectId) {
        reply.code(404);
        return { error: 'criterion not found' };
      }
      const update: Record<string, unknown> = {};
      if (body.title !== undefined) update.title = body.title;
      const effectiveKind = body.kind ?? existing.kind;
      if (body.kind !== undefined) update.kind = body.kind;
      if (body.spec !== undefined) {
        const specParsed = dodSpecForKind(effectiveKind).safeParse(body.spec);
        if (!specParsed.success) {
          reply.code(400);
          return {
            error: 'invalid_spec_for_kind',
            kind: effectiveKind,
            issues: specParsed.error.issues,
          };
        }
        update.specJson = specParsed.data;
      }
      if (body.position !== undefined) update.position = body.position;
      await db.update(dodCriteria).set(update).where(eq(dodCriteria.id, dodId)).run();
      const updated = await db.select().from(dodCriteria).where(eq(dodCriteria.id, dodId)).get();
      return updated;
    }),
  );

  app.delete(
    '/api/projects/:projectId/dod/:dodId',
    wrap(async (req, reply) => {
      const { projectId, dodId } = z
        .object({ projectId: z.string().min(1), dodId: z.string().min(1) })
        .parse(req.params);
      const existing = await db.select().from(dodCriteria).where(eq(dodCriteria.id, dodId)).get();
      if (!existing || existing.projectId !== projectId) {
        reply.code(404);
        return { error: 'criterion not found' };
      }
      await db.delete(dodCriteria).where(eq(dodCriteria.id, dodId)).run();
      reply.code(204);
      return null;
    }),
  );

  app.put(
    '/api/projects/:projectId/dod',
    wrap(async (req, reply) => {
      const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
      const body = bulkReplaceSchema.parse(req.body);
      const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) {
        reply.code(404);
        return { error: 'project not found' };
      }
      // Validate every spec against its kind upfront — refuse the whole
      // batch on any error so we don't half-replace.
      const validated: Array<{
        id: string;
        title: string;
        kind: DodKind;
        spec: Record<string, unknown>;
        position: number;
      }> = [];
      for (let i = 0; i < body.criteria.length; i++) {
        const c = body.criteria[i]!;
        const specParsed = dodSpecForKind(c.kind).safeParse(c.spec);
        if (!specParsed.success) {
          reply.code(400);
          return {
            error: 'invalid_spec_for_kind',
            index: i,
            kind: c.kind,
            issues: specParsed.error.issues,
          };
        }
        validated.push({
          id: randomUUID(),
          title: c.title,
          kind: c.kind,
          spec: specParsed.data as Record<string, unknown>,
          position: c.position ?? i,
        });
      }
      // Bulk replace in a single batch — fast and atomic-ish via SQLite WAL.
      await db.delete(dodCriteria).where(eq(dodCriteria.projectId, projectId)).run();
      for (const v of validated) {
        await db
          .insert(dodCriteria)
          .values({
            id: v.id,
            projectId,
            title: v.title,
            kind: v.kind,
            specJson: v.spec,
            position: v.position,
            createdAt: new Date(),
          })
          .run();
      }
      const rows = await db
        .select()
        .from(dodCriteria)
        .where(eq(dodCriteria.projectId, projectId))
        .orderBy(asc(dodCriteria.position), asc(dodCriteria.createdAt))
        .all();
      return rows;
    }),
  );

  // Dashboard convenience: the persisted runtime_reports row for a run.
  // Returns 404 when no row exists yet (run still in progress or runtime-
  // verify was disabled).
  app.get(
    '/api/runs/:runId/runtime-report',
    wrap(async (req, reply) => {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(req.params);
      const row = await db
        .select()
        .from(runtimeReports)
        .where(eq(runtimeReports.runId, runId))
        .orderBy(desc(runtimeReports.createdAt))
        .get();
      if (!row) {
        reply.code(404);
        return { error: 'no runtime report for this run' };
      }
      return row;
    }),
  );
};
