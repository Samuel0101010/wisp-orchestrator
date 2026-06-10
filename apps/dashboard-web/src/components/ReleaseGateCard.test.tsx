import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RuntimeReportRow } from '@/api/queries';
import { ReleaseGateCard } from './ReleaseGateCard';

// The card only reads `.data` from the hook — mock it wholesale so each test
// can shape the report row directly.
let reportData: RuntimeReportRow | null;

vi.mock('@/api/queries', () => ({
  useRuntimeReport: () => ({ data: reportData }),
}));

function makeReport(overrides: Partial<RuntimeReportRow> = {}): RuntimeReportRow {
  return {
    id: 'rr-1',
    runId: 'run-1',
    verdict: 'pass',
    bootOk: true,
    e2eOk: true,
    dodPassed: 3,
    dodTotal: 3,
    reportMd: null,
    evidenceJson: null,
    createdAt: '2026-06-10T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  reportData = makeReport();
});

describe('ReleaseGateCard', () => {
  it('renders nothing when no report row exists', () => {
    reportData = null;
    render(<ReleaseGateCard runId="run-1" />);
    expect(screen.queryByTestId('release-gate-card')).not.toBeInTheDocument();
  });

  it('shows boot/e2e/dod detail badges for an evaluated verdict', () => {
    reportData = makeReport({ verdict: 'fail', bootOk: false, e2eOk: true });
    render(<ReleaseGateCard runId="run-1" />);
    expect(screen.getByTestId('release-gate-verdict-fail')).toBeInTheDocument();
    expect(screen.getByText('Boot: FAIL')).toBeInTheDocument();
    expect(screen.getByText('E2E: PASS')).toBeInTheDocument();
    expect(screen.getByText('DoD: 3/3')).toBeInTheDocument();
  });

  it('hides the detail badges when the gate was skipped — never evaluated', () => {
    // A skipped gate carries bootOk/e2eOk defaults (false) that would render
    // as scary red FAIL badges on an otherwise green run.
    reportData = makeReport({
      verdict: 'skipped',
      bootOk: false,
      e2eOk: false,
      dodPassed: 0,
      dodTotal: 2,
    });
    render(<ReleaseGateCard runId="run-1" />);
    expect(screen.getByTestId('release-gate-card')).toBeInTheDocument();
    expect(screen.getByTestId('release-gate-verdict-skipped')).toBeInTheDocument();
    expect(screen.queryByText(/Boot:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/E2E:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/DoD:/)).not.toBeInTheDocument();
  });
});
