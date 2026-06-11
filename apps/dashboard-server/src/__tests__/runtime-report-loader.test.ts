import './setup.js';
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  dodCriteria as dodCriteriaTable,
  plans as plansTable,
  projects as projectsTable,
  runs as runsTable,
  runtimeReports as runtimeReportsTable,
} from '@wisp/schemas';
import { db } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import {
  countProjectDodCriteria,
  loadRuntimeReportFromRef,
  persistRuntimeReport,
  planHasRuntimeVerifier,
} from '../orchestrator/runtime-report-loader.js';
import { RUNTIME_VERIFIER_ROLE } from '../orchestrator/runtime-verifier.js';
import { evaluateReleaseGate } from '../orchestrator/release-gate.js';
import type { Plan } from '@wisp/schemas';
import type { RuntimeReportJson } from '../orchestrator/runtime-verifier.js';

beforeAll(() => {
  runMigrations();
});

describe('planHasRuntimeVerifier', () => {
  const basePlan: Plan = {
    goal: 'g',
    team: { roles: [] },
    nodes: [],
    edges: [],
  };

  it('returns false when no role is the verifier', () => {
    const plan: Plan = {
      ...basePlan,
      team: {
        roles: [
          {
            role: 'developer',
            model: 'sonnet',
            allowedTools: ['Read'],
            systemPrompt: 'x'.repeat(50),
          },
        ],
      },
    };
    expect(planHasRuntimeVerifier(plan)).toBe(false);
  });

  it('returns true when the role spec is in the team', () => {
    const plan: Plan = {
      ...basePlan,
      team: { roles: [RUNTIME_VERIFIER_ROLE] },
    };
    expect(planHasRuntimeVerifier(plan)).toBe(true);
  });
});

describe('countProjectDodCriteria', () => {
  let projectId: string;
  beforeEach(() => {
    projectId = randomUUID();
    db.insert(projectsTable)
      .values({ id: projectId, name: 'p', goal: 'g', repoPath: '/tmp' })
      .run();
  });

  it('returns 0/0 when no criteria are declared', async () => {
    const r = await countProjectDodCriteria(db, projectId);
    expect(r.total).toBe(0);
    expect(r.manual).toBe(0);
  });

  it('counts total and manual separately', async () => {
    db.insert(dodCriteriaTable)
      .values({
        id: randomUUID(),
        projectId,
        title: 'Login E2E',
        kind: 'e2e',
        specJson: { testFile: 't.spec.ts' },
        createdAt: new Date(),
      })
      .run();
    db.insert(dodCriteriaTable)
      .values({
        id: randomUUID(),
        projectId,
        title: 'Health smoke',
        kind: 'smoke',
        specJson: { url: '/health' },
        createdAt: new Date(),
      })
      .run();
    db.insert(dodCriteriaTable)
      .values({
        id: randomUUID(),
        projectId,
        title: 'Visual eyeball',
        kind: 'manual',
        specJson: { note: 'look at it' },
        createdAt: new Date(),
      })
      .run();
    const r = await countProjectDodCriteria(db, projectId);
    expect(r.total).toBe(3);
    expect(r.manual).toBe(1);
  });
});

describe('persistRuntimeReport', () => {
  let runId: string;
  beforeEach(() => {
    const projectId = randomUUID();
    const planId = randomUUID();
    runId = randomUUID();
    db.insert(projectsTable)
      .values({ id: projectId, name: 'p', goal: 'g', repoPath: '/tmp' })
      .run();
    db.insert(plansTable).values({ id: planId, projectId, dagJson: {}, status: 'locked' }).run();
    db.insert(runsTable)
      .values({
        id: runId,
        planId,
        status: 'completed',
        budgetMinutes: 1,
        budgetTurns: 1,
        maxParallel: 1,
      })
      .run();
  });

  it('writes a row with the gate verdict mapped onto runtime_reports.verdict', async () => {
    const gate = evaluateReleaseGate({
      runSucceeded: true,
      runtime: null,
      actionableFindingsCount: 0,
      dodTotal: 0,
      dodManual: 0,
      runtimeVerifyEnabled: false,
    });
    await persistRuntimeReport({
      db,
      runId,
      report: null,
      gate,
      markdownReport: null,
    });
    const rows = db
      .select()
      .from(runtimeReportsTable)
      .where(eq(runtimeReportsTable.runId, runId))
      .all();
    expect(rows.length).toBe(1);
    // gate=ready + no report → we map to verdict='skipped' so the dashboard
    // can distinguish "verifier didn't run" from a real pass/fail.
    expect(rows[0]?.verdict).toBe('skipped');
  });

  it('maps a manual-review gate (verify enabled, no report) to skipped — NOT a red error', async () => {
    // The Phase-6 ship-but-flag path: run succeeded, runtime-verify enabled, but
    // the verifier emitted no JSON. The gate degrades to manual-review (and
    // auto-merges). This must persist as a benign 'skipped' (amber), never the
    // 'error' (red) that would mislabel a successfully-merged app as a failure.
    const gate = evaluateReleaseGate({
      runSucceeded: true,
      runtime: null,
      actionableFindingsCount: 0,
      dodTotal: 0,
      dodManual: 0,
      runtimeVerifyEnabled: true,
    });
    expect(gate.verdict).toBe('manual-review');
    await persistRuntimeReport({ db, runId, report: null, gate, markdownReport: null });
    const rows = db
      .select()
      .from(runtimeReportsTable)
      .where(eq(runtimeReportsTable.runId, runId))
      .all();
    expect(rows[0]?.verdict).toBe('skipped');
    expect(rows[0]?.verdict).not.toBe('error');
  });

  it('preserves the runtime report verdict when one was produced', async () => {
    const report: RuntimeReportJson = {
      verdict: 'fail',
      boot: { ok: true },
      e2e: { ok: false, passed: 1, failed: 2 },
    };
    const gate = evaluateReleaseGate({
      runSucceeded: true,
      runtime: report,
      actionableFindingsCount: 0,
      dodTotal: 0,
      dodManual: 0,
      runtimeVerifyEnabled: true,
    });
    await persistRuntimeReport({
      db,
      runId,
      report,
      gate,
      markdownReport: '# Runtime Verification Report\n\n_FAIL_',
    });
    const rows = db
      .select()
      .from(runtimeReportsTable)
      .where(eq(runtimeReportsTable.runId, runId))
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.verdict).toBe('fail');
    expect(rows[0]?.reportMd).toContain('FAIL');
  });

  it('persists the gate verdict + reasons alongside the verifier verdict (migration 0021)', async () => {
    // A verifier "pass" with an unevidenced DoD criterion → gate=blocked. The
    // dashboard needs that decision on the row, else it shows READY while
    // auto-merge silently held the code back.
    const report: RuntimeReportJson = {
      verdict: 'pass',
      boot: { ok: true },
      e2e: { ok: true, passed: 0, failed: 0 },
      smoke: { ok: true, passed: 1, failed: 0 },
      dod: {
        criteria: [
          { id: 'dod-1', title: 'Login', verified: true },
          { id: 'dod-2', title: 'Cart', verified: false },
        ],
      },
    };
    const gate = evaluateReleaseGate({
      runSucceeded: true,
      runtime: report,
      actionableFindingsCount: 0,
      dodTotal: 2,
      dodManual: 0,
      runtimeVerifyEnabled: true,
    });
    expect(gate.verdict).toBe('blocked');
    await persistRuntimeReport({ db, runId, report, gate, markdownReport: null });
    const rows = db
      .select()
      .from(runtimeReportsTable)
      .where(eq(runtimeReportsTable.runId, runId))
      .all();
    expect(rows[0]?.verdict).toBe('pass');
    expect(rows[0]?.gateVerdict).toBe('blocked');
    expect(rows[0]?.gateReasons?.join(' ')).toMatch(/unevidenced/);
  });
});

describe('loadRuntimeReportFromRef', () => {
  it('returns null when the file is missing at the given ref', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-empty-'));
    try {
      await execa('git', ['init', '-q'], { cwd: dir });
      await execa('git', ['config', 'user.email', 't@t'], { cwd: dir });
      await execa('git', ['config', 'user.name', 't'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'README.md'), '# t');
      await execa('git', ['add', '.'], { cwd: dir });
      await execa('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
      const r = await loadRuntimeReportFromRef({ repoPath: dir, ref: 'HEAD' });
      expect(r).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads and parses a runtime-report.json committed at the ref', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-full-'));
    try {
      await execa('git', ['init', '-q'], { cwd: dir });
      await execa('git', ['config', 'user.email', 't@t'], { cwd: dir });
      await execa('git', ['config', 'user.name', 't'], { cwd: dir });
      const docsDir = path.join(dir, 'docs');
      fs.mkdirSync(docsDir);
      const report: RuntimeReportJson = {
        verdict: 'pass',
        boot: { ok: true },
        e2e: { ok: true, passed: 3, failed: 0 },
      };
      fs.writeFileSync(path.join(docsDir, 'runtime-report.json'), JSON.stringify(report));
      await execa('git', ['add', '.'], { cwd: dir });
      await execa('git', ['commit', '-q', '-m', 'add report'], { cwd: dir });
      const r = await loadRuntimeReportFromRef({ repoPath: dir, ref: 'HEAD' });
      expect(r?.verdict).toBe('pass');
      expect(r?.e2e?.passed).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
