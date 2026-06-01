import { describe, it, expect } from 'vitest';
import {
  planStatusValues,
  runStatusValues,
  taskStatusValues,
  runOutcomeValues,
} from '@wisp/schemas';
import de from '../i18n/locales/de/common.json';
import en from '../i18n/locales/en/common.json';

// `statusLabel(x, t)` resolves `t(`status.${x}`, { defaultValue: x })`, so any enum
// value that reaches it WITHOUT a matching `status.*` key renders the raw snake_case
// token in BOTH locales (the budget_exceeded / skipped leak class). statusLabel
// call-sites feed it plan/run/task status AND run.outcome (RunView, ProjectDetail,
// Insights, StatusDotBadge), so every value below must have a key in both locales.
const reachable = [
  ...planStatusValues,
  ...runStatusValues,
  ...taskStatusValues,
  ...runOutcomeValues,
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
