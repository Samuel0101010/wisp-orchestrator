/**
 * plan-identity — chokepoint that pins every agent identity in a plan to a
 * trusted source before the plan can reach the walker.
 *
 * Threat model: PATCH /api/plans/:planId (and any other path that writes
 * dagJson) accepts a full Plan body. The walker resolves agent specs from
 * plan.team — NOT from the stored team row — so a client could smuggle an
 * attacker-chosen systemPrompt / model / allowedTools into a team role (new
 * role name OR same-name override) and have the run execute it.
 *
 * Normalisation contract:
 *   - Known system roles (wire-up / runtime-verifier / lead) are replaced by
 *     the CANONICAL server spec (which carries origin:'system').
 *   - Every other team role is replaced by the STORED team spec with the same
 *     role name — the stored spec wins even when the names match, killing the
 *     "same name, modified systemPrompt" attack.
 *   - Anything else is invalid.
 *   - Node origins are normalised: origin='system' iff node.role is a known
 *     system role, else stripped (only server-side injectors may badge a node
 *     as System).
 *   - Node roles must be in stored ∪ system.
 */
import type { AgentSpec, Plan, Team } from '@wisp/schemas';
import { WIRE_UP_ROLE } from './wire-up.js';
import { RUNTIME_VERIFIER_ROLE } from './runtime-verifier.js';
import { LEAD_ROLE } from './inject-lead-checkpoint.js';

/** Canonical specs for the harness-injected system roles, keyed by role name. */
const SYSTEM_ROLE_SPECS: ReadonlyMap<string, AgentSpec> = new Map(
  [WIRE_UP_ROLE, RUNTIME_VERIFIER_ROLE, LEAD_ROLE].map((spec) => [spec.role, spec]),
);

export type NormalizeResult = { ok: true; plan: Plan } | { ok: false; invalidRoles: string[] };

/**
 * Enforce: every team role is either replaced by the STORED team spec (same
 * role name) or, for the known system roles (wire-up / runtime-verifier /
 * lead), by the CANONICAL server spec — anything else is invalid. Node
 * origins are normalized: origin='system' iff node.role is a known system
 * role, else stripped. Node roles must be in stored ∪ system.
 */
export function normalizePlanIdentity(plan: Plan, storedTeam: Team): NormalizeResult {
  const storedByRole = new Map(storedTeam.roles.map((r) => [r.role, r]));
  const invalid = new Set<string>();

  const roles: AgentSpec[] = [];
  for (const r of plan.team.roles) {
    const canonical = SYSTEM_ROLE_SPECS.get(r.role);
    if (canonical) {
      roles.push(canonical);
      continue;
    }
    const stored = storedByRole.get(r.role);
    if (stored) {
      roles.push(stored);
      continue;
    }
    invalid.add(r.role);
  }

  const nodes = plan.nodes.map((n) => {
    if (SYSTEM_ROLE_SPECS.has(n.role)) {
      return { ...n, origin: 'system' as const };
    }
    if (!storedByRole.has(n.role)) {
      invalid.add(n.role);
    }
    return { ...n, origin: undefined };
  });

  if (invalid.size > 0) {
    return { ok: false, invalidRoles: [...invalid] };
  }
  return { ok: true, plan: { ...plan, team: { roles }, nodes } };
}
