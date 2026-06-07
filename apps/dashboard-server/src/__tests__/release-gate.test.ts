import './setup.js';
import { describe, expect, it } from 'vitest';
import { evaluateReleaseGate, renderReleaseGateMarkdown } from '../orchestrator/release-gate.js';
import type { RuntimeReportJson } from '../orchestrator/runtime-verifier.js';

function passReport(over: Partial<RuntimeReportJson> = {}): RuntimeReportJson {
  return {
    verdict: 'pass',
    boot: { ok: true },
    e2e: { ok: true, passed: 1, failed: 0 },
    smoke: { ok: true, passed: 1, failed: 0 },
    dod: { criteria: [{ id: 'dod-1', title: 'Login', verified: true }] },
    ...over,
  };
}

describe('evaluateReleaseGate', () => {
  it('blocks when the run itself did not succeed', () => {
    const r = evaluateReleaseGate({
      runSucceeded: false,
      runtime: passReport(),
      actionableFindingsCount: 0,
      dodTotal: 1,
      dodManual: 0,
      runtimeVerifyEnabled: true,
    });
    expect(r.verdict).toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/did not complete/);
  });

  it('marks ready when runtime-verify is disabled and no findings remain', () => {
    const r = evaluateReleaseGate({
      runSucceeded: true,
      runtime: null,
      actionableFindingsCount: 0,
      dodTotal: 0,
      dodManual: 0,
      runtimeVerifyEnabled: false,
    });
    expect(r.verdict).toBe('ready');
    expect(r.reasons.join(' ')).toMatch(/runtime-verify disabled/);
  });

  it('ships with manual-review when verify enabled but the agent emitted no JSON report', () => {
    const r = evaluateReleaseGate({
      runSucceeded: true,
      runtime: null,
      actionableFindingsCount: 0,
      dodTotal: 0,
      dodManual: 0,
      runtimeVerifyEnabled: true,
    });
    // Was a hard block (code stranded on a branch); now ships + flags so the
    // user actually sees their app and is told to verify it.
    expect(r.verdict).toBe('manual-review');
    expect(r.reasons.join(' ')).toMatch(/runtime-verifier did not produce/);
  });

  it('still blocks when the report is missing AND actionable findings remain', () => {
    const r = evaluateReleaseGate({
      runSucceeded: true,
      runtime: null,
      actionableFindingsCount: 3,
      dodTotal: 0,
      dodManual: 0,
      runtimeVerifyEnabled: true,
    });
    expect(r.verdict).toBe('blocked');
  });

  it('blocks on boot failure even if verdict says pass (defensive)', () => {
    const r = evaluateReleaseGate({
      runSucceeded: true,
      runtime: passReport({ boot: { ok: false, reason: 'ECONNREFUSED' }, verdict: 'pass' }),
      actionableFindingsCount: 0,
      dodTotal: 1,
      dodManual: 0,
      runtimeVerifyEnabled: true,
    });
    expect(r.verdict).toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/ECONNREFUSED/);
  });

  it('blocks on verdict=fail and exposes per-component failure counts', () => {
    const r = evaluateReleaseGate({
      runSucceeded: true,
      runtime: {
        verdict: 'fail',
        boot: { ok: true },
        e2e: { ok: false, passed: 2, failed: 3 },
        smoke: { ok: true, passed: 0, failed: 0 },
      },
      actionableFindingsCount: 0,
      dodTotal: 0,
      dodManual: 0,
      runtimeVerifyEnabled: true,
    });
    expect(r.verdict).toBe('blocked');
    expect(r.summary.e2eFailed).toBe(3);
  });

  it('blocks when actionable findings remain even on a pass verdict (self-healing kicks in)', () => {
    const r = evaluateReleaseGate({
      runSucceeded: true,
      runtime: passReport(),
      actionableFindingsCount: 2,
      dodTotal: 1,
      dodManual: 0,
      runtimeVerifyEnabled: true,
    });
    expect(r.verdict).toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/2 actionable/);
  });

  it('blocks when an auto-verifiable DoD criterion is unevidenced', () => {
    const r = evaluateReleaseGate({
      runSucceeded: true,
      runtime: passReport({
        dod: {
          criteria: [
            { id: 'dod-1', title: 'Login', verified: true },
            { id: 'dod-2', title: 'Cart', verified: false },
          ],
        },
      }),
      actionableFindingsCount: 0,
      dodTotal: 2,
      dodManual: 0,
      runtimeVerifyEnabled: true,
    });
    expect(r.verdict).toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/unevidenced/);
  });

  it('returns manual-review when auto gates pass and a manual gate remains', () => {
    const r = evaluateReleaseGate({
      runSucceeded: true,
      runtime: passReport(),
      actionableFindingsCount: 0,
      dodTotal: 2,
      dodManual: 1,
      runtimeVerifyEnabled: true,
    });
    expect(r.verdict).toBe('manual-review');
    expect(r.reasons.join(' ')).toMatch(/manual DoD gate/);
  });

  it('returns ready when everything is green and no manual gates remain', () => {
    const r = evaluateReleaseGate({
      runSucceeded: true,
      runtime: passReport(),
      actionableFindingsCount: 0,
      dodTotal: 1,
      dodManual: 0,
      runtimeVerifyEnabled: true,
    });
    expect(r.verdict).toBe('ready');
  });

  // Regression: FocusBoard run eac482c1 — runtime-verifier wrote
  // `Boot: PASS` to docs/runtime-report.{md,json}, but the release-gate
  // displayed "Boot: FAIL" because it tried to re-probe boot from scratch
  // (with no preview server alive at that moment) instead of trusting the
  // verifier's evidence. The three cases below pin the contract:
  //   A) verifier said boot OK → gate trusts it, NEVER re-probes
  //   B) verifier said boot FAIL → gate still fails (existing behaviour)
  //   C) no verifier evidence at all → existing fallback (block) holds
  describe('runtime-verifier boot evidence trust (regression: FocusBoard run eac482c1)', () => {
    it('case A: trusts the verifier when boot=OK and does NOT call the live re-probe', () => {
      let probeCalls = 0;
      const probeBootFn = () => {
        probeCalls += 1;
        return { ok: false, reason: 'should not have been called' };
      };
      const r = evaluateReleaseGate({
        runSucceeded: true,
        runtime: passReport(),
        actionableFindingsCount: 0,
        dodTotal: 1,
        dodManual: 0,
        runtimeVerifyEnabled: true,
        probeBootFn,
      });
      expect(probeCalls).toBe(0);
      expect(r.summary.bootOk).toBe(true);
      expect(r.verdict).toBe('ready');
    });

    it('case B: blocks on verifier boot=FAIL and does NOT call the live re-probe', () => {
      let probeCalls = 0;
      const probeBootFn = () => {
        probeCalls += 1;
        return { ok: true }; // pretend a live re-probe would have lied
      };
      const r = evaluateReleaseGate({
        runSucceeded: true,
        runtime: passReport({ boot: { ok: false, reason: 'ECONNREFUSED' } }),
        actionableFindingsCount: 0,
        dodTotal: 1,
        dodManual: 0,
        runtimeVerifyEnabled: true,
        probeBootFn,
      });
      expect(probeCalls).toBe(0);
      expect(r.verdict).toBe('blocked');
      expect(r.reasons.join(' ')).toMatch(/ECONNREFUSED/);
      expect(r.summary.bootOk).toBe(false);
    });

    it('case C: ships manual-review (not block) when no verifier evidence and no probe provided', () => {
      const r = evaluateReleaseGate({
        runSucceeded: true,
        runtime: null,
        actionableFindingsCount: 0,
        dodTotal: 0,
        dodManual: 0,
        runtimeVerifyEnabled: true,
      });
      expect(r.verdict).toBe('manual-review');
      expect(r.reasons.join(' ')).toMatch(/runtime-verifier did not produce/);
      expect(r.summary.bootOk).toBe(false);
    });

    it('case C-bis: legacy plan with a fallback probe — probe IS called; ships manual-review when boot OK', () => {
      let probeCalls = 0;
      const probeBootFn = () => {
        probeCalls += 1;
        return { ok: true };
      };
      const r = evaluateReleaseGate({
        runSucceeded: true,
        runtime: null,
        actionableFindingsCount: 0,
        dodTotal: 0,
        dodManual: 0,
        runtimeVerifyEnabled: true,
        probeBootFn,
      });
      expect(probeCalls).toBe(1);
      // Probe confirmed boot → dashboard sees bootOk=true (no spurious
      // "Boot: FAIL"); with no e2e/smoke/dod evidence we ship + flag rather
      // than strand the finished code on a branch.
      expect(r.summary.bootOk).toBe(true);
      expect(r.verdict).toBe('manual-review');
      expect(r.reasons.join(' ')).toMatch(/runtime-verifier did not produce/);
    });

    it('case C-ter: a fallback probe that FAILS still blocks (the app genuinely did not boot)', () => {
      const r = evaluateReleaseGate({
        runSucceeded: true,
        runtime: null,
        actionableFindingsCount: 0,
        dodTotal: 0,
        dodManual: 0,
        runtimeVerifyEnabled: true,
        probeBootFn: () => ({ ok: false, reason: 'ECONNREFUSED' }),
      });
      expect(r.verdict).toBe('blocked');
      expect(r.reasons.join(' ')).toMatch(/did not boot/);
    });
  });
});

describe('renderReleaseGateMarkdown', () => {
  it('reflects the verdict in the banner heading', () => {
    const result = evaluateReleaseGate({
      runSucceeded: true,
      runtime: passReport(),
      actionableFindingsCount: 0,
      dodTotal: 1,
      dodManual: 0,
      runtimeVerifyEnabled: true,
    });
    const md = renderReleaseGateMarkdown({ result, runId: 'run-abc', iteration: 0 });
    expect(md).toMatch(/RELEASE GATE: READY/);
    expect(md).toMatch(/run-abc/);
  });

  it('lists the reasons as bullet points for the dashboard', () => {
    const result = evaluateReleaseGate({
      runSucceeded: true,
      runtime: null,
      actionableFindingsCount: 0,
      dodTotal: 0,
      dodManual: 0,
      runtimeVerifyEnabled: true,
    });
    const md = renderReleaseGateMarkdown({ result, runId: 'r1', iteration: 0 });
    expect(md).toMatch(/- runtime-verifier did not produce/);
  });
});
