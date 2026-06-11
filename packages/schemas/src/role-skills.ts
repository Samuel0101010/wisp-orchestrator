/**
 * Default execution-skill assignment per role name. Single source of truth
 * shared by every surface that builds an AgentSpec from a role/agent name:
 * the server's DEFAULT_PLAN_TEAM + HARDEN_TEAM, the chat create_project
 * directive, the built-in team templates, and the web Team Builder's
 * "add built-in agent" flow.
 *
 * The names reference seed skills shipped with the harness
 * (apps/dashboard-server/src/skills/seed/). Rendering skips unknown names,
 * so assigning these is always safe even if a registry is missing them.
 */

export const BUILDER_DISCIPLINE_SKILL = 'builder-discipline';
export const QA_VERIFICATION_SKILL = 'qa-verification';
export const FRONTEND_QUALITY_SKILL = 'frontend-quality';

const QA_RE = /(^|-)qa(-|$)|quality|tester/;
const FRONTEND_RE = /frontend|front-end|ui-dev|web-dev/;
const BUILDER_RE = /dev|engineer|builder|coder|programmer|security|packager/;

/**
 * Map a kebab-case role name to its default skills. QA wins over the builder
 * match ("qa-engineer" must not become a builder); frontend builders get the
 * visual-quality skill on top of the shared build discipline. Roles that
 * don't write code (architect, designer, tech-writer, lead, …) get none.
 */
export function defaultSkillsForRole(role: string): string[] {
  const r = role.trim().toLowerCase();
  if (r.length === 0) return [];
  if (QA_RE.test(r)) return [QA_VERIFICATION_SKILL];
  if (FRONTEND_RE.test(r)) return [BUILDER_DISCIPLINE_SKILL, FRONTEND_QUALITY_SKILL];
  if (BUILDER_RE.test(r)) return [BUILDER_DISCIPLINE_SKILL];
  return [];
}
