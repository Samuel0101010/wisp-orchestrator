import { eq, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { events, runSummaries, type NewRunSummary } from '@agent-harness/schemas';
import { invokeSkill } from '../skills/invoker.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { SubprocessRunner } from '@agent-harness/orchestrator';

const TRANSCRIPT_BUDGET_CHARS = 24_000;
const SUMMARY_MAX_CHARS = 8_000;

export function buildTranscript(runId: string): string {
  const rows = db.select().from(events).where(eq(events.runId, runId)).orderBy(asc(events.ts)).all();
  const lines: string[] = [];
  let chars = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    const ts = (r.ts instanceof Date ? r.ts : new Date(r.ts as unknown as string)).toISOString();
    const payload = typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload);
    const line = `${ts} [${r.type}] ${payload}`;
    if (chars + line.length > TRANSCRIPT_BUDGET_CHARS) break;
    chars += line.length + 1;
    lines.unshift(line);
  }
  return lines.join('\n');
}

function detectMode(summary: string): string | null {
  const m = summary.toLowerCase();
  if (m.includes('implementation') || m.includes('coded') || m.includes('refactor')) return 'implement';
  if (m.includes('plan') || m.includes('proposed')) return 'plan';
  if (m.includes('reviewed') || m.includes('audit')) return 'review';
  return null;
}

export interface SummarizeRunOpts {
  runId: string;
  projectId: string;
  registry: SkillRegistry;
  runner?: SubprocessRunner;
}

/**
 * Idempotent: if a run_summaries row already exists for runId, returns
 * early without invoking the skill. Otherwise invokes summarize-thread,
 * truncates to 8KB, and persists.
 */
export async function summarizeRun(opts: SummarizeRunOpts): Promise<void> {
  const existing = db.select().from(runSummaries).where(eq(runSummaries.runId, opts.runId)).get();
  if (existing) return;

  const transcript = buildTranscript(opts.runId);
  if (transcript.length === 0) return;

  const result = await invokeSkill({
    registry: opts.registry,
    name: 'summarize-thread',
    args: transcript,
    runner: opts.runner,
  });

  if (result.failed || !result.text) return;

  const summary =
    result.text.length > SUMMARY_MAX_CHARS ? result.text.slice(0, SUMMARY_MAX_CHARS) : result.text;

  const row: NewRunSummary = {
    runId: opts.runId,
    projectId: opts.projectId,
    summaryMd: summary,
    mode: detectMode(summary),
    tokensTotal: (result.tokensIn ?? 0) + (result.tokensOut ?? 0),
    createdAt: new Date(),
  };
  db.insert(runSummaries).values(row).onConflictDoNothing().run();
}
