import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { events as eventsTable, runs, type RunPausedReason } from '@agent-harness/schemas';
import { eq, and } from 'drizzle-orm';
import { checkAutopilotBudget } from './budget.js';
import { tryCheckoutRun, releaseCheckout } from '../checkout/atomic-checkout.js';

/**
 * Pause reasons that autopilot is allowed to resume from automatically.
 *
 * - `rate-limit`: the harness saw a rate-limit signal. Resume becomes safe
 *   when `runs.resumeAt` is in the past (the rate-limit window closed).
 * - `shutdown`: the server died with the run in `status='running'`; the
 *   abrupt-crash recovery flipped it to `paused/shutdown`. Resuming after
 *   server restart is exactly what the user wants.
 *
 * `user` is intentionally excluded — the human pressed Pause and meant it.
 * `consecutive-failures` is excluded too — that pause signals a structural
 * issue the walker detected; auto-resuming would just trip the same
 * threshold again. Both require a manual Resume click.
 */
const AUTO_RESUMABLE_REASONS: ReadonlySet<RunPausedReason> = new Set<RunPausedReason>([
  'rate-limit',
  'shutdown',
]);

/** Skip-reason names emitted to the audit event so the user can see why
 *  a tick declined to act on a paused run. */
type SkipReason =
  | 'pause-reason-not-auto-resumable'
  | 'rate-limit-window-still-open'
  | 'checkout-failed';

export interface AutopilotTickResult {
  resumed: string[];
  halted: string[];
  skipped: Array<{ runId: string; reason: SkipReason }>;
}

function persistAutopilotEvent(runId: string, payload: Record<string, unknown>): void {
  try {
    db.insert(eventsTable)
      .values({
        id: randomUUID(),
        runId,
        taskId: null,
        type: 'autopilot.decision',
        payload,
        ts: new Date(),
      })
      .run();
  } catch (err) {
    // Don't let event persistence fail the actual decision loop.
    console.error('[autopilot-tick] failed to persist decision event', err);
  }
}

export async function tickAutopilot(): Promise<AutopilotTickResult> {
  const candidates = db
    .select()
    .from(runs)
    .where(and(eq(runs.autopilotMode, true), eq(runs.status, 'paused')))
    .all();
  const resumed: string[] = [];
  const halted: string[] = [];
  const skipped: Array<{ runId: string; reason: SkipReason }> = [];
  const nowMs = Date.now();

  for (const run of candidates) {
    // Gate 1 — pause reason. Only rate-limit + shutdown qualify. A user
    // pause or consecutive-failures pause is left alone.
    if (!run.pausedReason || !AUTO_RESUMABLE_REASONS.has(run.pausedReason)) {
      skipped.push({ runId: run.id, reason: 'pause-reason-not-auto-resumable' });
      // No event emit for this — it would spam every tick.
      continue;
    }

    // Gate 2 — rate-limit window respect. The rate-limit handler set
    // `resumeAt` when it paused; resuming before that just bounces off the
    // same rate-limit again. We wait silently until the window closes.
    if (run.pausedReason === 'rate-limit' && run.resumeAt) {
      const resumeAtMs =
        run.resumeAt instanceof Date
          ? run.resumeAt.getTime()
          : new Date(run.resumeAt as unknown as string).getTime();
      if (resumeAtMs > nowMs) {
        skipped.push({ runId: run.id, reason: 'rate-limit-window-still-open' });
        continue;
      }
    }

    // Gate 3 — budget. If the autopilot's own caps are blown, cancel the
    // run with outcome=budget_exceeded so a follow-up doesn't waste tokens.
    const tokens = run.tokensInTotal + run.tokensOutTotal;
    const v = checkAutopilotBudget(run, tokens);
    if (v.exceeded) {
      await db
        .update(runs)
        .set({
          status: 'cancelled',
          endedAt: new Date(),
          outcome: 'budget_exceeded',
        })
        .where(eq(runs.id, run.id))
        .run();
      halted.push(run.id);
      persistAutopilotEvent(run.id, {
        action: 'halted',
        reason: 'budget-exceeded',
        detail: v.reason,
      });
      continue;
    }

    // Atomically claim this paused run before resuming. If another tick
    // (or a manual /resume) beat us to it, skip silently — they'll handle it.
    const checkout = tryCheckoutRun(run.id, 'paused', 'running');
    if (!checkout.ok) {
      skipped.push({ runId: run.id, reason: 'checkout-failed' });
      continue;
    }
    try {
      // Defer-import to avoid circular import: routes/runs.ts already imports many things
      const { getDefaultRuntime } = await import('../routes/runs.js');
      const runtime = getDefaultRuntime();
      const result = await runtime.resumeRun(run.id);
      if (result.ok) {
        resumed.push(run.id);
        persistAutopilotEvent(run.id, {
          action: 'resumed',
          pausedReason: run.pausedReason,
        });
      } else {
        halted.push(run.id);
        persistAutopilotEvent(run.id, {
          action: 'resume-failed',
          pausedReason: run.pausedReason,
          detail: result.error,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[autopilot-tick] failed to resume', run.id, msg);
      halted.push(run.id);
      persistAutopilotEvent(run.id, {
        action: 'resume-errored',
        pausedReason: run.pausedReason,
        detail: msg,
      });
    } finally {
      releaseCheckout(run.id, checkout.token);
    }
  }
  return { resumed, halted, skipped };
}
