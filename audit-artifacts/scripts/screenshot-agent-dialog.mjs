import { chromium } from '../../tests/e2e/node_modules/@playwright/test/index.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'screenshots');

const browser = await chromium.launch();
try {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(
      ({ theme }) => {
        try {
          window.localStorage.setItem('agent-harness-lang', 'en');
          window.localStorage.setItem(
            'agent-harness-ui',
            JSON.stringify({ state: { theme }, version: 0 }),
          );
        } catch {
          /* ignore */
        }
      },
      { theme },
    );
    const page = await ctx.newPage();
    await page.goto('http://localhost:5173/agents');
    await page.locator('[data-testid="sidebar-mission-control"]').waitFor();
    // Click "New agent" button — its text varies; match by /new agent/i on a button.
    const newBtn = page.getByRole('button', { name: /new agent/i }).first();
    await newBtn.click();
    await page.getByText('Allowed tools', { exact: true }).waitFor({ timeout: 5000 });
    const file = path.join(out, `v1.6.1-agent-dialog-${theme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`saved ${file}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
