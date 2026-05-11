import { expect, test } from '@playwright/test';
import { setLang } from './helpers/set-lang';

const PAGES = [
  '/', '/chat', '/agents', '/skills', '/workers', '/insights', '/goap',
  '/prompt-bundles',
] as const;

test.describe('every button is accessible', () => {
  for (const path of PAGES) {
    test(`${path}: every button has a name`, async ({ page }, testInfo) => {
      const lang = testInfo.project.metadata.lang as 'en' | 'de';
      await setLang(page, lang);
      await page.goto(path);
      // Wait for a deterministic UI signal — networkidle never fires with our
      // polling queries + WebSocket.
      await page.locator('[data-testid="sidebar-mission-control"]').waitFor();
      await page.getByRole('heading', { level: 1 }).first().waitFor();

      // Every <button> must be reachable by an accessible name: either visible
      // text, an aria-label, or an aria-labelledby.
      const buttons = await page.locator('button:visible').all();
      const noName: string[] = [];
      for (const b of buttons) {
        const accessibleName = await b.evaluate((el) => {
          const aria = el.getAttribute('aria-label');
          if (aria && aria.trim()) return aria;
          const labelledBy = el.getAttribute('aria-labelledby');
          if (labelledBy) {
            const labeller = document.getElementById(labelledBy);
            if (labeller?.textContent?.trim()) return labeller.textContent.trim();
          }
          if (el.textContent?.trim()) return el.textContent.trim();
          return null;
        });
        if (!accessibleName) {
          const html = await b.evaluate((el) => el.outerHTML.slice(0, 200));
          noName.push(html);
        }
      }
      expect(noName, `Found ${noName.length} buttons with no accessible name:\n${noName.join('\n')}`).toEqual([]);
    });
  }
});
