import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { setLang } from './helpers/set-lang';

const PAGES = [
  { path: '/', name: 'home' },
  { path: '/chat', name: 'chat' },
  { path: '/agents', name: 'agents' },
  { path: '/skills', name: 'skills' },
  { path: '/workers', name: 'workers' },
  { path: '/insights', name: 'insights' },
  { path: '/goap', name: 'goap' },
  { path: '/prompt-bundles', name: 'prompt-bundles' },
] as const;

test.describe('a11y scan', () => {
  for (const { path, name } of PAGES) {
    test(`${name} has no serious/critical axe violations`, async ({ page }, testInfo) => {
      const lang = testInfo.project.metadata.lang as 'en' | 'de';
      await setLang(page, lang);
      await page.goto(path);
      // Don't use waitForLoadState('networkidle') — our SPA polls /api/runs every
      // 5–10s and keeps a WebSocket open; "networkidle" never fires. Wait for a
      // deterministic UI signal instead.
      await page.locator('[data-testid="sidebar-mission-control"]').waitFor();
      await page.getByRole('heading', { level: 1 }).first().waitFor();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .disableRules(['color-contrast']) // re-enabled after Phase 3 token migration
        .analyze();
      const blocking = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
    });
  }
});
