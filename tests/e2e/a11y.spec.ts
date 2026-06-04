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

// Scan the settled page: emulate prefers-reduced-motion so entry animations
// (staggered opacity fade-ups) resolve to their end state instead of being
// caught mid-fade, where transient low opacity trips axe's colour-contrast
// rule. This is also the accessible state reduced-motion users actually see.
test.use({ reducedMotion: 'reduce' });

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
      // Some pages (e.g., /chat) have no h1 — wait only on the sidebar signal.
      // Let staggered entry animations (opacity fade-ups) settle before axe
      // runs, so it scans the final, accessible state instead of a transient
      // low-opacity frame. Capped so infinite loops (pulse dots) can't hang it.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const done = Promise.allSettled(
              document
                .getAnimations()
                .filter((a) => (a.effect?.getTiming().iterations ?? 1) !== Infinity)
                .map((a) => a.finished),
            );
            void done.then(() => resolve());
            setTimeout(resolve, 1500);
          }),
      );
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      const blocking = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
    });
  }
});
