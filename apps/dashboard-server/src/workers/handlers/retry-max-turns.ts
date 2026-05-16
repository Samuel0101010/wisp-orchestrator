import { eq, and, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { runs } from '@wisp/schemas';
import { tryCheckoutRun, releaseCheckout } from '../../checkout/atomic-checkout.js';

const MAX_RETRIES = 4;

interface RuntimeLike {
  resumeRun(runId: string): Promise<{ ok: boolean; error?: string }>;
}

let injectedRuntime: RuntimeLike | null = null;
export function setRetryMaxTurnsRuntime(runtime: RuntimeLike): void {
  injectedRuntime = runtime;
}

/**
 * Public unit-test entrypoint — accepts an explicit runtime so tests
 * don't depend on the singleton.
 */
export async function retryMaxTurnsImpl(
  runtime: RuntimeLike,
): Promise<{ retried: string[]; halted: string[] }> {
  const now = Date.now();
  const candidates = db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.errorReason, 'max_turns'),
        eq(runs.status, 'failed'),
        sql`${runs.retryCount} < ${MAX_RETRIES}`,
        sql`${runs.nextRetryAt} IS NOT NULL AND ${runs.nextRetryAt} <= ${now}`,
      ),
    )
    .all();

  const retried: string[] = [];
  const halted: string[] = [];
  for (const run of candidates) {
    if (run.retryCount >= MAX_RETRIES) {
      halted.push(run.id);
      continue;
    }
    // Atomically claim by moving from 'failed' → 'paused' first; resumeRun
    // will pick it up from there (it accepts both paused and running).
    const checkout = tryCheckoutRun(run.id, 'failed', 'paused');
    if (!checkout.ok) continue; // someone else has it
    try {
      // Bump retryCount BEFORE attempting resume so a crash doesn't loop forever.
      db.update(runs)
        .set({ retryCount: run.retryCount + 1, errorReason: null })
        .where(eq(runs.id, run.id))
        .run();
      const result = await runtime.resumeRun(run.id);
      if (result.ok) retried.push(run.id);
      else halted.push(run.id);
    } finally {
      releaseCheckout(run.id, checkout.token);
    }
  }
  return { retried, halted };
}

export async function retryMaxTurns(): Promise<{ retried: string[]; halted: string[] }> {
  if (!injectedRuntime) return { retried: [], halted: [] };
  return retryMaxTurnsImpl(injectedRuntime);
}
