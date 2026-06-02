import { describe, it, expect } from 'vitest';
import {
  planStatusValues,
  runStatusValues,
  taskStatusValues,
  runOutcomeValues,
  workerRunStatusValues,
  runtimeReportVerdictValues,
  changeRequestStatusValues,
} from '@wisp/schemas';
import de from '../i18n/locales/de/common.json';
import en from '../i18n/locales/en/common.json';
import { statusMeta } from './status-labels';

// `statusLabel(x, t)` resolves `t(`status.${x}`, { defaultValue: x })`, so any enum
// value that reaches it WITHOUT a matching `status.*` key renders the raw snake_case
// token in BOTH locales (the budget_exceeded / skipped leak class). statusLabel
// call-sites feed it plan/run/task status AND run.outcome, worker-run status, verify
// verdicts and change-request status, so every value below must have a key in both
// locales.
const reachable = [
  ...planStatusValues,
  ...runStatusValues,
  ...taskStatusValues,
  ...runOutcomeValues,
  ...workerRunStatusValues,
  ...runtimeReportVerdictValues,
  ...changeRequestStatusValues,
];

describe('status.* i18n coverage for statusLabel', () => {
  for (const { name, dict } of [
    { name: 'de', dict: de },
    { name: 'en', dict: en },
  ]) {
    it(`${name}: every status/outcome value reaching statusLabel has a status.* key`, () => {
      const status = (dict as { status?: Record<string, string> }).status ?? {};
      const missing = [...new Set(reachable)].filter((v) => !(v in status));
      expect(missing).toEqual([]);
    });
  }
});

describe('statusMeta', () => {
  it('maps running to a live info state', () => {
    expect(statusMeta('running')).toMatchObject({ tone: 'info', live: true });
  });

  it('pairs every status with a renderable icon (never colour-only)', () => {
    for (const s of ['running', 'failed', 'completed', 'pending', 'unknown-x']) {
      expect(statusMeta(s).Icon).toBeTruthy();
    }
  });

  it('assigns sensible tones across the run/task/plan/outcome/worker/verdict vocab', () => {
    expect(statusMeta('completed').tone).toBe('success');
    expect(statusMeta('done').tone).toBe('success');
    expect(statusMeta('ok').tone).toBe('success');
    expect(statusMeta('pass').tone).toBe('success');
    expect(statusMeta('failed').tone).toBe('destructive');
    expect(statusMeta('failure').tone).toBe('destructive');
    expect(statusMeta('error').tone).toBe('destructive');
    expect(statusMeta('budget_exceeded').tone).toBe('destructive');
    expect(statusMeta('paused').tone).toBe('warning');
    expect(statusMeta('locked').tone).toBe('info');
    expect(statusMeta('cancelled').tone).toBe('neutral');
    expect(statusMeta('skipped').tone).toBe('neutral');
    expect(statusMeta('in-run').live).toBe(true);
  });

  it('returns a defined entry for every schema lifecycle value', () => {
    for (const s of new Set(reachable)) {
      expect(statusMeta(s)).toBeTruthy();
    }
  });

  it('falls back to neutral, non-live for unknown values', () => {
    expect(statusMeta('totally-unknown')).toMatchObject({ tone: 'neutral', live: false });
  });
});
