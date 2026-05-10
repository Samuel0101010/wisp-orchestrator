import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { runs, type RunStatus } from '@agent-harness/schemas';

export type CheckoutResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'not_found' | 'status_mismatch' };

/**
 * Atomic run state transition. Claims a run by transitioning its status
 * from `fromStatus` to `toStatus` and stamping a unique checkout token,
 * all within a single SQLite transaction. Returns `{ ok: true, token }`
 * on success, `{ ok: false, reason }` if the precondition was violated.
 */
export function tryCheckoutRun(
  runId: string,
  fromStatus: RunStatus,
  toStatus: RunStatus,
): CheckoutResult {
  const token = randomUUID();
  const tx = sqlite.transaction(() => {
    const row = db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!row) return { ok: false as const, reason: 'not_found' as const };
    if (row.status !== fromStatus)
      return { ok: false as const, reason: 'status_mismatch' as const };
    db.update(runs)
      .set({ status: toStatus, checkoutToken: token })
      .where(and(eq(runs.id, runId), eq(runs.status, fromStatus)))
      .run();
    return { ok: true as const, token };
  });
  return tx();
}

/**
 * Release a checkout — clears the token on a run. Call after the
 * subsequent terminal state transition has been persisted.
 */
export function releaseCheckout(runId: string, token: string): void {
  db.update(runs)
    .set({ checkoutToken: null })
    .where(and(eq(runs.id, runId), eq(runs.checkoutToken, token)))
    .run();
}
