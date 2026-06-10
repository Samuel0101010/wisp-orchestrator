/**
 * release-gate — the final say on whether a finished run is releasable.
 *
 * Phase A built the persistence; Phase B fills in the decision. The gate is
 * a pure function over four signals:
 *
 *   1. Build / unit-test result (already enforced by the walker; if a run
 *      reaches success its outcome is by definition success on these).
 *   2. The runtime-verifier's structured verdict from
 *      docs/runtime-report.json (parsed by runtime-verifier.parseRuntimeReportJson).
 *   3. The actionable-findings count from the existing findings scanner
 *      (security-review + qa-report + runtime-report, all in one bucket).
 *   4. The DoD criteria the user declared on the project: did the verifier
 *      evidence each one? Manual gates don't auto-pass — but they don't
 *      auto-fail either; they show up in the dashboard as "human required".
 *
 * The post-success hook in runtime.ts calls evaluateReleaseGate() right
 * before deciding whether to auto-merge and whether to spawn a hardening
 * chain iteration.
 */
import type { RuntimeReportJson } from './runtime-verifier.js';

export type ReleaseVerdict = 'ready' | 'blocked' | 'manual-review';

export interface ReleaseGateInput {
  /** True iff the run completed with outcome=success. */
  runSucceeded: boolean;
  /** Verdict the runtime-verifier wrote, or null if no report was produced. */
  runtime: RuntimeReportJson | null;
  /** Number of CRITICAL/HIGH/MEDIUM findings still open across all sources. */
  actionableFindingsCount: number;
  /** How many DoD criteria the project declared. */
  dodTotal: number;
  /** How many DoD criteria are of kind=manual. Counted separately because they
   *  block auto-release but don't block the chain. */
  dodManual: number;
  /** Whether the project has runtime-verify enabled. Disabled projects skip
   *  this gate entirely and the verdict is purely build+test+findings. */
  runtimeVerifyEnabled: boolean;
  /**
   * Optional fallback boot probe. The gate invokes this ONLY when
   * `runtimeVerifyEnabled` is true AND `runtime` is null — i.e. the
   * verifier node didn't produce a parsable docs/runtime-report.json
   * (legacy plan, agent crash before write, etc.). When `runtime` IS
   * present, the verifier's structured evidence is the source of truth
   * and this probe is NEVER called — re-probing on top of fresh evidence
   * is what caused the FocusBoard "Boot: FAIL" false negative this fix
   * addresses.
   */
  probeBootFn?: () => { ok: boolean; reason?: string };
  /**
   * Harness-side boot check of the RESULT-BRANCH code in a managed worktree
   * (see harness-boot-check.ts). `null`/`undefined` = skipped (no bootable
   * dev surface, or a harness infra error) — the gate ignores it. `ok:false`
   * is authoritative and blocks regardless of the in-run verifier's report:
   * the verifier may have probed a different tree, this check booted exactly
   * what the run produced.
   */
  harnessBoot?: { ok: boolean; reason?: string } | null;
}

export interface ReleaseGateResult {
  verdict: ReleaseVerdict;
  /** Short human-readable lines surfaced in release-gate.md + dashboard. */
  reasons: string[];
  /** Summary counts the dashboard shows in the run card. */
  summary: {
    bootOk: boolean;
    e2ePassed: number;
    e2eFailed: number;
    smokePassed: number;
    smokeFailed: number;
    dodVerified: number;
    dodTotal: number;
    dodManual: number;
  };
}

function zeros(): ReleaseGateResult['summary'] {
  return {
    bootOk: false,
    e2ePassed: 0,
    e2eFailed: 0,
    smokePassed: 0,
    smokeFailed: 0,
    dodVerified: 0,
    dodTotal: 0,
    dodManual: 0,
  };
}

export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateResult {
  const reasons: string[] = [];
  const summary = zeros();
  summary.dodTotal = input.dodTotal;
  summary.dodManual = input.dodManual;

  if (!input.runSucceeded) {
    reasons.push('run did not complete with outcome=success');
    return { verdict: 'blocked', reasons, summary };
  }

  if (input.harnessBoot && !input.harnessBoot.ok) {
    summary.bootOk = false;
    reasons.push(`harness boot check failed: ${input.harnessBoot.reason ?? 'no reason given'}`);
    return { verdict: 'blocked', reasons, summary };
  }

  if (input.actionableFindingsCount > 0) {
    reasons.push(
      `${input.actionableFindingsCount} actionable (HIGH/CRITICAL/MEDIUM) finding(s) still open`,
    );
  }

  if (!input.runtimeVerifyEnabled) {
    // Without runtime-verify the gate degrades to: any findings ⇒ blocked,
    // else ready. No DoD checking, no boot signal.
    if (input.actionableFindingsCount > 0) {
      return { verdict: 'blocked', reasons, summary };
    }
    reasons.push(
      'runtime-verify disabled for this project — releasing on build+test+findings only',
    );
    return { verdict: 'ready', reasons, summary };
  }

  if (!input.runtime) {
    // No verifier evidence on disk (legacy plan, or the verifier crashed
    // before writing docs/runtime-report.json). The run otherwise succeeded.
    // A fallback live probe (for legacy plans) still gates on actual boot.
    if (input.probeBootFn) {
      const probe = input.probeBootFn();
      summary.bootOk = probe.ok;
      if (!probe.ok) {
        reasons.push(
          `app did not boot (live re-probe fallback): ${probe.reason ?? 'no reason given'}`,
        );
        return { verdict: 'blocked', reasons, summary };
      }
    }
    // Known HIGH/CRITICAL/MEDIUM findings still block — don't ship code with
    // unresolved issues just because the verifier report happens to be missing.
    if (input.actionableFindingsCount > 0) {
      reasons.push('verifier evidence is missing AND actionable findings are still open');
      return { verdict: 'blocked', reasons, summary };
    }
    // The run succeeded, boot is OK (or unprobed) and nothing actionable is
    // open — but we lack e2e/smoke/dod evidence. Rather than STRANDING finished
    // code on a branch (the user never sees their app), ship it with a visible
    // manual-review flag so a human can spot-check it. Auto-merge proceeds for
    // any non-blocked verdict.
    reasons.push(
      'runtime-verifier did not produce docs/runtime-report.json — shipping with a manual-review flag (please verify the app manually)',
    );
    return { verdict: 'manual-review', reasons, summary };
  }

  // Populate summary from the runtime report. When the verifier has spoken,
  // its structured evidence is authoritative — we deliberately do NOT call
  // probeBootFn here even if one was provided, because re-probing on top of
  // fresh evidence is the bug this code path exists to prevent.
  summary.bootOk = input.runtime.boot.ok;
  summary.e2ePassed = input.runtime.e2e?.passed ?? 0;
  summary.e2eFailed = input.runtime.e2e?.failed ?? 0;
  summary.smokePassed = input.runtime.smoke?.passed ?? 0;
  summary.smokeFailed = input.runtime.smoke?.failed ?? 0;
  summary.dodVerified = (input.runtime.dod?.criteria ?? []).filter((c) => c.verified).length;

  if (!input.runtime.boot.ok) {
    reasons.push(`app did not boot: ${input.runtime.boot.reason ?? 'no reason given'}`);
    return { verdict: 'blocked', reasons, summary };
  }

  if (input.runtime.verdict === 'fail') {
    reasons.push('runtime-verifier reported verdict=fail');
    if (summary.e2eFailed > 0) reasons.push(`${summary.e2eFailed} E2E test(s) failed`);
    if (summary.smokeFailed > 0) reasons.push(`${summary.smokeFailed} smoke check(s) failed`);
    return { verdict: 'blocked', reasons, summary };
  }

  if (input.runtime.verdict === 'error') {
    reasons.push('runtime-verifier crashed / errored — see docs/runtime-report.md');
    return { verdict: 'blocked', reasons, summary };
  }

  if (input.actionableFindingsCount > 0) {
    // verdict=pass but findings remain. Self-healing will pick them up.
    return { verdict: 'blocked', reasons, summary };
  }

  // Auto-verified gates pass; do manual gates still need a human?
  const autoVerifiable = Math.max(0, summary.dodTotal - summary.dodManual);
  if (summary.dodVerified < autoVerifiable) {
    reasons.push(
      `${autoVerifiable - summary.dodVerified} non-manual DoD criterion/criteria still unevidenced`,
    );
    return { verdict: 'blocked', reasons, summary };
  }

  if (summary.dodManual > 0) {
    reasons.push(`${summary.dodManual} manual DoD gate(s) — waiting for human approver`);
    return { verdict: 'manual-review', reasons, summary };
  }

  reasons.push('all gates passed');
  return { verdict: 'ready', reasons, summary };
}

/**
 * Renders the structured result as a release-gate.md report. Lives next to
 * docs/runtime-report.md so the dashboard can display it inline and the
 * findings parser can pick up any HIGH-severity rows we emit here.
 */
export function renderReleaseGateMarkdown(args: {
  result: ReleaseGateResult;
  runId: string;
  iteration: number;
}): string {
  const { result } = args;
  const banner =
    result.verdict === 'ready'
      ? '**RELEASE GATE: READY** — auto-merge will proceed.'
      : result.verdict === 'manual-review'
        ? '**RELEASE GATE: MANUAL REVIEW** — auto-verifiable gates passed; a human must sign off the manual criteria.'
        : '**RELEASE GATE: BLOCKED** — see reasons below.';

  const reasonsBlock = result.reasons.length
    ? result.reasons.map((r) => `- ${r}`).join('\n')
    : '_(no reasons recorded)_';

  return `# Release Gate (run \`${args.runId}\`, iteration ${args.iteration})

${banner}

## Reasons

${reasonsBlock}

## Summary

| Gate | Status |
|---|---|
| Boot | ${result.summary.bootOk ? 'PASS' : 'FAIL'} |
| E2E | ${result.summary.e2ePassed} passed / ${result.summary.e2eFailed} failed |
| Smoke | ${result.summary.smokePassed} passed / ${result.summary.smokeFailed} failed |
| DoD criteria | ${result.summary.dodVerified} / ${result.summary.dodTotal} verified (${result.summary.dodManual} manual) |
`;
}
