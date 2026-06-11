/**
 * Glue layer between the runtime-verifier's on-disk artifacts and the
 * post-success hook.
 *
 * The verifier writes docs/runtime-report.json into the result branch. We
 * `git show` it back here so the hook can:
 *   1. parse the structured verdict (via parseRuntimeReportJson)
 *   2. persist a `runtime_reports` row for the dashboard
 *   3. feed it into evaluateReleaseGate
 *
 * Everything is best-effort: missing file ⇒ return null and let the gate
 * decide what to do with the absence. We never block on read errors;
 * blocking decisions live in evaluateReleaseGate where they're testable.
 */

import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { and, count, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  dodCriteria as dodCriteriaTable,
  runtimeReports as runtimeReportsTable,
} from '@wisp/schemas';
import type { Plan, RuntimeReportVerdict } from '@wisp/schemas';
import { parseRuntimeReportJson, type RuntimeReportJson } from './runtime-verifier.js';
import type { ReleaseGateResult } from './release-gate.js';

export const RUNTIME_REPORT_JSON_PATH = 'docs/runtime-report.json';
export const RUNTIME_REPORT_MD_PATH = 'docs/runtime-report.md';

/**
 * Read docs/runtime-report.json at `ref` from `repoPath` and parse it.
 * Returns null on any error (missing file, bad JSON, schema mismatch).
 */
export async function loadRuntimeReportFromRef(args: {
  repoPath: string;
  ref: string;
}): Promise<RuntimeReportJson | null> {
  try {
    const { stdout } = await execa('git', ['show', `${args.ref}:${RUNTIME_REPORT_JSON_PATH}`], {
      cwd: args.repoPath,
    });
    return parseRuntimeReportJson(stdout);
  } catch {
    return null;
  }
}

/**
 * Read docs/runtime-report.md at `ref` so it can be persisted alongside the
 * structured verdict — the dashboard renders this verbatim in the run view.
 */
export async function loadRuntimeReportMarkdownFromRef(args: {
  repoPath: string;
  ref: string;
}): Promise<string | null> {
  try {
    const { stdout } = await execa('git', ['show', `${args.ref}:${RUNTIME_REPORT_MD_PATH}`], {
      cwd: args.repoPath,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Count the project's declared DoD criteria, with a separate count of
 * kind=manual rows. These two numbers feed straight into evaluateReleaseGate
 * so we can compute "all auto gates passed / manual gates pending sign-off".
 */
export async function countProjectDodCriteria(
  db: BetterSQLite3Database,
  projectId: string,
): Promise<{ total: number; manual: number }> {
  const totalRow = await db
    .select({ n: count() })
    .from(dodCriteriaTable)
    .where(eq(dodCriteriaTable.projectId, projectId))
    .get();
  const manualRow = await db
    .select({ n: count() })
    .from(dodCriteriaTable)
    .where(and(eq(dodCriteriaTable.projectId, projectId), eq(dodCriteriaTable.kind, 'manual')))
    .get();
  return {
    total: totalRow?.n ?? 0,
    manual: manualRow?.n ?? 0,
  };
}

/**
 * Persist a `runtime_reports` row capturing what the verifier produced
 * (or didn't) and what the gate decided. One row per (run, verifier
 * iteration). Returns the new row id.
 */
export async function persistRuntimeReport(args: {
  db: BetterSQLite3Database;
  runId: string;
  report: RuntimeReportJson | null;
  gate: ReleaseGateResult;
  markdownReport: string | null;
}): Promise<string> {
  const id = randomUUID();
  // The runtime-report.json verdict is the source of truth when present,
  // but the dashboard needs a single field that captures "what the harness
  // ultimately decided". With no report, only a BLOCKED gate is a real error;
  // a `ready` or `manual-review` gate shipped the code (auto-merge proceeds), so
  // map it to the benign `skipped` (amber) — NOT `error` (red), which would
  // mislabel a successfully-merged app as a verifier failure. ('manual-review'
  // is not in the persisted enum; `skipped` is its closest non-destructive fit.)
  const verdict: RuntimeReportVerdict = args.report
    ? args.report.verdict
    : args.gate.verdict === 'blocked'
      ? 'error'
      : 'skipped';
  await args.db
    .insert(runtimeReportsTable)
    .values({
      id,
      runId: args.runId,
      verdict,
      bootOk: args.gate.summary.bootOk,
      e2eOk: args.gate.summary.e2eFailed === 0 && args.gate.summary.e2ePassed >= 0,
      dodPassed: args.gate.summary.dodVerified,
      dodTotal: args.gate.summary.dodTotal,
      reportMd: args.markdownReport,
      evidenceJson: args.report?.artifacts ? { artifacts: args.report.artifacts } : null,
      // The gate decision itself — a verifier "pass" can still end blocked
      // (unevidenced DoD, open findings); the dashboard must be able to say so.
      gateVerdict: args.gate.verdict,
      gateReasons: args.gate.reasons,
    })
    .run();
  return id;
}

/**
 * Pure helper: does the plan include a runtime-verifier role? Used by the
 * post-success hook to decide whether a missing runtime-report.json is
 * "legacy plan, ignore" or "the verifier was expected but didn't produce
 * its artifact" (a release-gate FAIL signal).
 */
export function planHasRuntimeVerifier(plan: Plan): boolean {
  return plan.team.roles.some((r) => r.role === 'runtime-verifier');
}
