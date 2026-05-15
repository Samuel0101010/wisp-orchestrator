/**
 * Per-project agent-override loader (v1.14 Phase 6).
 *
 * Each project may carry a row in `project_agent_overrides` per role. The
 * walker reads them when composing a task's subprocess invocation and:
 *   - appends `extra_system_prompt` to the role's base system prompt
 *   - unions `extra_allowed_tools` into the role's allowedTools list
 *   - swaps `model` when set
 *
 * This helper centralises the lookup so callers receive an immutable map
 * (role → merge fields) and apply it themselves. The walker stays a pure
 * function of its inputs; the dashboard-server pre-loads the map before
 * each run.
 *
 * Wiring TODO(phase-6-followup): the walker doesn't yet consume this map
 * — it still uses the un-merged role config from the team. The shape is
 * exported + the CRUD endpoints are live so the UI can edit overrides
 * today; the runtime hook lands in a follow-up release once the
 * WalkerDeps signature settles.
 */
import { eq } from 'drizzle-orm';
import { projectAgentOverrides, type AgentModel } from '@agent-harness/schemas';
import { db as defaultDb } from '../db/index.js';

export interface AgentOverrideMerge {
  role: string;
  model: AgentModel | null;
  extraSystemPrompt: string | null;
  extraAllowedTools: string[] | null;
  memoryNamespace: string | null;
}

/**
 * Returns a map of role → merge fields. Roles with no override row are
 * omitted; the walker is expected to fall back to the base config in that
 * case. A connection-less version exists as `applyAgentOverrides` for unit
 * tests.
 */
export async function loadAgentOverridesForProject(
  projectId: string,
  db: typeof defaultDb = defaultDb,
): Promise<Record<string, AgentOverrideMerge>> {
  const rows = await db
    .select()
    .from(projectAgentOverrides)
    .where(eq(projectAgentOverrides.projectId, projectId))
    .all();
  const out: Record<string, AgentOverrideMerge> = {};
  for (const r of rows) {
    out[r.role] = {
      role: r.role,
      model: (r.model ?? null) as AgentModel | null,
      extraSystemPrompt: r.extraSystemPrompt ?? null,
      extraAllowedTools: r.extraAllowedTools ?? null,
      memoryNamespace: r.memoryNamespace ?? null,
    };
  }
  return out;
}

/**
 * Pure function: merge a base agent config with the override fields. Used by
 * walker integration; exported for tests so callers can unit-test the merge
 * without touching SQLite.
 */
export function applyAgentOverride<
  T extends { model: AgentModel; systemPrompt: string; allowedTools: string[] },
>(base: T, override: AgentOverrideMerge | null | undefined): T {
  if (!override) return base;
  const next: T = { ...base };
  if (override.model) next.model = override.model;
  if (override.extraSystemPrompt && override.extraSystemPrompt.trim().length > 0) {
    next.systemPrompt = `${base.systemPrompt}\n\n${override.extraSystemPrompt}`;
  }
  if (override.extraAllowedTools && override.extraAllowedTools.length > 0) {
    const merged = new Set<string>(base.allowedTools);
    for (const t of override.extraAllowedTools) merged.add(t);
    next.allowedTools = Array.from(merged);
  }
  return next;
}
