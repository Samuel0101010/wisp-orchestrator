/**
 * Module-scope holder for the most recent auth probe result.
 * Set by server.bootstrap(); read by /api/health, the send/run gates, and
 * tests. Gates must use {@link refreshAuthProbeIfFailed} instead of the raw
 * getter: a boot-time probe can time out on a busy machine (e.g. while a
 * build hogs the CPU) and a cached failure must not brick chat + runs until
 * the next server restart.
 */

import { probeSubscriptionAuth, type AuthProbeResult } from '@wisp/orchestrator';

let lastAuthProbe: AuthProbeResult | null = null;

export function setLastAuthProbe(result: AuthProbeResult | null): void {
  lastAuthProbe = result;
}

export function getLastAuthProbe(): AuthProbeResult | null {
  return lastAuthProbe;
}

const REPROBE_MIN_INTERVAL_MS = 60_000;
let reprobeInFlight: Promise<AuthProbeResult | null> | null = null;
let lastReprobeAt = 0;

/** Test seam — probe implementation override + throttle reset. */
let probeImpl: () => Promise<AuthProbeResult> = () => probeSubscriptionAuth();
export function _setAuthProbeImplForTests(impl?: () => Promise<AuthProbeResult>): void {
  probeImpl = impl ?? (() => probeSubscriptionAuth());
  reprobeInFlight = null;
  lastReprobeAt = 0;
}

/**
 * Freshest auth verdict for the send/run gates. Passing or never-probed
 * results return immediately; a cached FAILURE triggers a live re-probe
 * (throttled to once per minute, shared across concurrent callers) so a
 * transient boot hiccup self-heals on the next user action instead of
 * 503-blocking until restart. /api/health reads the same store, so the
 * banner clears too.
 */
export async function refreshAuthProbeIfFailed(): Promise<AuthProbeResult | null> {
  const last = lastAuthProbe;
  if (!last || last.ok) return last;
  if (reprobeInFlight) return reprobeInFlight;
  const now = Date.now();
  if (now - lastReprobeAt < REPROBE_MIN_INTERVAL_MS) return last;
  lastReprobeAt = now;
  reprobeInFlight = probeImpl()
    .then((result) => {
      lastAuthProbe = result;
      return result;
    })
    .catch(() => last)
    .finally(() => {
      reprobeInFlight = null;
    });
  return reprobeInFlight;
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
