/**
 * Model B backfill: ensures every team role has a matching `agents` row and
 * its `agentId` is recorded back into `teams.rolesJson`.
 *
 * Runs at server boot, idempotent. Safe to run on every start (no-ops once
 * all roles are linked). Uses synchronous better-sqlite3 transactions so
 * partial failures roll back.
 */

import { randomUUID } from 'node:crypto';
import { agents, teams, type NewAgent } from '@wisp/schemas';
import { db, sqlite } from './index.js';

interface InlineRole {
  role: string;
  model: 'opus' | 'sonnet' | 'haiku';
  allowedTools: string[];
  systemPrompt: string;
  agentId?: string;
}

interface RolesJson {
  roles: InlineRole[];
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

interface BackfillStats {
  teamsScanned: number;
  rolesAlreadyLinked: number;
  agentsCreated: number;
  rolesLinked: number;
}

export function backfillAgents(): BackfillStats {
  const stats: BackfillStats = {
    teamsScanned: 0,
    rolesAlreadyLinked: 0,
    agentsCreated: 0,
    rolesLinked: 0,
  };

  // Read team rows + their project name in one go for naming purposes.
  const rows = sqlite
    .prepare<unknown[], { id: string; projectId: string; rolesJson: string; projectName: string }>(
      `SELECT t.id AS id, t.project_id AS projectId, t.roles_json AS rolesJson,
              p.name AS projectName
       FROM teams t
       JOIN projects p ON p.id = t.project_id`,
    )
    .all();

  if (rows.length === 0) return stats;

  // Run all updates in one transaction.
  const tx = sqlite.transaction(() => {
    for (const row of rows) {
      stats.teamsScanned += 1;
      let parsed: RolesJson;
      try {
        parsed = typeof row.rolesJson === 'string' ? JSON.parse(row.rolesJson) : row.rolesJson;
      } catch {
        // Corrupt rolesJson — skip. We don't risk overwriting it.
        continue;
      }
      if (!parsed || !Array.isArray(parsed.roles)) continue;

      const updated: InlineRole[] = [];
      let dirty = false;

      for (const r of parsed.roles) {
        if (r.agentId) {
          // Verify the referenced agent still exists; if not, treat as unlinked.
          const exists = sqlite.prepare('SELECT 1 FROM agents WHERE id = ?').get(r.agentId);
          if (exists) {
            stats.rolesAlreadyLinked += 1;
            updated.push(r);
            continue;
          }
        }

        // Create a new agent for this role.
        const now = Date.now();
        const id = randomUUID();
        const name = `${slugify(row.projectName)}-${r.role}`;
        const newAgent: NewAgent = {
          id,
          name,
          model: r.model,
          systemPrompt: r.systemPrompt,
          allowedTools: r.allowedTools,
          color: null,
          description: `Auto-created from team role on ${new Date(now).toISOString().slice(0, 10)}`,
          createdAt: new Date(now),
          updatedAt: new Date(now),
        };
        sqlite
          .prepare(
            `INSERT INTO agents (id, name, model, system_prompt, allowed_tools, color, description, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            name,
            r.model,
            r.systemPrompt,
            JSON.stringify(r.allowedTools),
            null,
            newAgent.description,
            now,
            now,
          );
        stats.agentsCreated += 1;
        updated.push({ ...r, agentId: id });
        stats.rolesLinked += 1;
        dirty = true;
      }

      if (dirty) {
        const newJson = JSON.stringify({ roles: updated });
        sqlite.prepare('UPDATE teams SET roles_json = ? WHERE id = ?').run(newJson, row.id);
      }
    }
  });
  tx();

  // Sanity check via Drizzle (also exercises the join path).
  void db.select().from(agents).limit(1).all();
  void db.select().from(teams).limit(1).all();

  return stats;
}
