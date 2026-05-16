/**
 * Agents (Model B) — CRUD over the global agent registry.
 *
 *   GET    /api/agents            list
 *   POST   /api/agents            create
 *   GET    /api/agents/:id        read one
 *   PATCH  /api/agents/:id        partial update
 *   DELETE /api/agents/:id        delete (refuses if referenced by any team
 *                                  unless ?force=1)
 *
 * Wire shape mirrors the SQL row but JSON-encodes allowedTools as an array
 * (Drizzle handles that already). Timestamps go out as ms-epoch numbers.
 */

import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { agents, createAgentInputSchema, updateAgentInputSchema } from '@wisp/schemas';
import { db, sqlite } from '../db/index.js';
import { wrap } from './wrap.js';

interface RolesJson {
  roles: Array<{ agentId?: string; [k: string]: unknown }>;
}

/**
 * Parse a teams.roles_json value, returning `null` on corruption. We log
 * the failure so an admin can see it (silent skip masks real data bugs)
 * but keep the same skip-on-fail behaviour at the call sites so one
 * corrupted team row doesn't break a whole listing endpoint.
 */
function parseRolesJson(value: string | object, context: string): RolesJson | null {
  try {
    return (typeof value === 'string' ? JSON.parse(value) : value) as RolesJson;
  } catch (err) {
    console.warn(
      `[agents:${context}] failed to parse teams.roles_json:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function isReferenced(agentId: string): boolean {
  const rows = sqlite
    .prepare<unknown[], { rolesJson: string | object }>(`SELECT roles_json AS rolesJson FROM teams`)
    .all();
  for (const r of rows) {
    const json = parseRolesJson(r.rolesJson, 'isReferenced');
    if (!json || !Array.isArray(json.roles)) continue;
    for (const role of json.roles) {
      if (role.agentId === agentId) return true;
    }
  }
  return false;
}

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/agents',
    wrap(async () => {
      const rows = await db.select().from(agents).orderBy(desc(agents.updatedAt)).all();
      return rows;
    }),
  );

  app.post(
    '/api/agents',
    wrap(async (req, reply) => {
      const parsed = createAgentInputSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'invalid_body', issues: parsed.error.issues };
      }
      const now = new Date();
      const row = {
        id: randomUUID(),
        name: parsed.data.name,
        model: parsed.data.model,
        systemPrompt: parsed.data.systemPrompt,
        allowedTools: parsed.data.allowedTools,
        color: parsed.data.color ?? null,
        description: parsed.data.description ?? null,
        avatarUrl: parsed.data.avatarUrl ?? null,
        seedKey: null,
        kind: 'user' as const,
        createdAt: now,
        updatedAt: now,
      };
      await db.insert(agents).values(row).run();
      reply.code(201);
      return row;
    }),
  );

  app.get(
    '/api/agents/:id',
    wrap(async (req, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const row = await db.select().from(agents).where(eq(agents.id, id)).get();
      if (!row) {
        reply.code(404);
        return { error: 'agent_not_found' };
      }
      return row;
    }),
  );

  app.patch(
    '/api/agents/:id',
    wrap(async (req, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const parsed = updateAgentInputSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'invalid_body', issues: parsed.error.issues };
      }
      const existing = await db.select().from(agents).where(eq(agents.id, id)).get();
      if (!existing) {
        reply.code(404);
        return { error: 'agent_not_found' };
      }
      const updates: Partial<typeof existing> = { updatedAt: new Date() };
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.model !== undefined) updates.model = parsed.data.model;
      if (parsed.data.systemPrompt !== undefined) updates.systemPrompt = parsed.data.systemPrompt;
      if (parsed.data.allowedTools !== undefined) updates.allowedTools = parsed.data.allowedTools;
      if (parsed.data.color !== undefined) updates.color = parsed.data.color ?? null;
      if (parsed.data.description !== undefined)
        updates.description = parsed.data.description ?? null;
      if (parsed.data.avatarUrl !== undefined) updates.avatarUrl = parsed.data.avatarUrl ?? null;
      await db.update(agents).set(updates).where(eq(agents.id, id)).run();
      const updated = await db.select().from(agents).where(eq(agents.id, id)).get();
      return updated ?? existing;
    }),
  );

  app.delete(
    '/api/agents/:id',
    wrap(async (req, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const query = z
        .object({ force: z.union([z.literal('1'), z.literal('true')]).optional() })
        .parse(req.query);
      const existing = await db.select().from(agents).where(eq(agents.id, id)).get();
      if (!existing) {
        reply.code(404);
        return { error: 'agent_not_found' };
      }
      if (!query.force && isReferenced(id)) {
        reply.code(409);
        return {
          error: 'agent_referenced',
          message:
            'Agent is used in a team. Pass ?force=1 to delete anyway (team roles will keep their inline config).',
        };
      }
      // If forced, scrub agentId from any team rolesJson that references it,
      // so the inline values continue to drive the orchestrator. We don't
      // delete the team — the role just becomes "unlinked".
      if (query.force) {
        const rows = sqlite
          .prepare<
            unknown[],
            { id: string; rolesJson: string | object }
          >('SELECT id, roles_json AS rolesJson FROM teams')
          .all();
        const updateStmt = sqlite.prepare('UPDATE teams SET roles_json = ? WHERE id = ?');
        const tx = sqlite.transaction(() => {
          for (const r of rows) {
            const json = parseRolesJson(r.rolesJson, 'forceDelete');
            if (!json || !Array.isArray(json.roles)) continue;
            let dirty = false;
            const next = json.roles.map((role) => {
              if (role.agentId === id) {
                dirty = true;
                const { agentId: _agentId, ...rest } = role;
                void _agentId;
                return rest;
              }
              return role;
            });
            if (dirty) {
              updateStmt.run(JSON.stringify({ roles: next }), r.id);
            }
          }
        });
        tx();
      }
      await db.delete(agents).where(eq(agents.id, id)).run();
      reply.code(204);
      return null;
    }),
  );

  // Convenience: which teams reference this agent? Used by the UI to confirm
  // delete safety and to populate "this agent is on N teams" badges.
  app.get(
    '/api/agents/:id/usage',
    wrap(async (req, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const existing = await db.select().from(agents).where(eq(agents.id, id)).get();
      if (!existing) {
        reply.code(404);
        return { error: 'agent_not_found' };
      }
      const rows = sqlite
        .prepare<
          unknown[],
          { teamId: string; projectId: string; projectName: string; rolesJson: string | object }
        >(
          `SELECT t.id AS teamId, t.project_id AS projectId, p.name AS projectName, t.roles_json AS rolesJson
           FROM teams t
           JOIN projects p ON p.id = t.project_id`,
        )
        .all();
      const usage: Array<{ teamId: string; projectId: string; projectName: string; role: string }> =
        [];
      for (const r of rows) {
        const json = parseRolesJson(r.rolesJson, 'usage');
        if (json && Array.isArray(json.roles)) {
          for (const role of json.roles) {
            if (role.agentId === id) {
              usage.push({
                teamId: r.teamId,
                projectId: r.projectId,
                projectName: r.projectName,
                role: typeof role.role === 'string' ? role.role : '',
              });
            }
          }
        }
      }
      return { usage };
    }),
  );
};
