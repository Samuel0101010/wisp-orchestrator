import { z } from 'zod';
import { teamSchema, type Team } from './plan.js';

export { teamSchema } from './plan.js';
export type { Team } from './plan.js';

/**
 * Parse a Team object (validates SHAPE only). The slot/role coherence check
 * (e.g. team.architect.role === 'architect') is enforced at the route layer
 * for clearer 400 messages.
 */
export function parseTeam(input: unknown): Team {
  return teamSchema.parse(input);
}

export function safeParseTeam(input: unknown): z.SafeParseReturnType<unknown, Team> {
  return teamSchema.safeParse(input);
}
