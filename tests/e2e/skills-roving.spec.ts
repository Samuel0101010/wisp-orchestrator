import { expect, test } from '@playwright/test';
import { setLang } from './helpers/set-lang';

// Arrow-key roving tabindex on the Skills filter tablist:
// pressing ArrowRight moves focus + activeFilter to the next tab.
test.describe('Skills tablist arrow-key roving', () => {
  test('ArrowRight cycles focus and selection across tabs', async ({ page }, testInfo) => {
    const lang = testInfo.project.metadata.lang as 'en' | 'de';
    await setLang(page, lang);
    await page.goto('/skills');
    await page.locator('[data-testid="sidebar-mission-control"]').waitFor();

    const firstTab = page.locator('[role="tab"][data-filter="all"]');
    await firstTab.waitFor();
    await firstTab.focus();
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('ArrowRight');
    const seedTab = page.locator('[role="tab"][data-filter="seed"]');
    await expect(seedTab).toBeFocused();
    await expect(seedTab).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('ArrowLeft');
    await expect(firstTab).toBeFocused();
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
  });
});
