/**
 * Module-scope holder for the most recent boot-time auth probe result.
 * Set by server.bootstrap(); read by /api/health and by tests.
 */

import type { AuthProbeResult } from '@wisp/orchestrator';

let lastAuthProbe: AuthProbeResult | null = null;

export function setLastAuthProbe(result: AuthProbeResult | null): void {
  lastAuthProbe = result;
}

export function getLastAuthProbe(): AuthProbeResult | null {
  return lastAuthProbe;
}

/** Shape exposed via /api/health — strips internal fields like durationMs. */
export interface AuthProbeStatus {
  ok: boolean;
  hint?: string;
}

export function authProbeStatus(): AuthProbeStatus | null {
  if (!lastAuthProbe) return null;
  if (lastAuthProbe.ok) return { ok: true };
  return { ok: false, hint: lastAuthProbe.hint };
}
