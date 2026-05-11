import { expect, test } from '@playwright/test';
import { setLang } from './helpers/set-lang';
import { tt } from './helpers/locator-by-key';

interface PageSpec {
  path: string;
  expectStrings: string[];
  headingKey?: string;
}

const PAGES: PageSpec[] = [
  {
    path: '/agents',
    headingKey: 'agents.title',
    expectStrings: ['agents.sections.builtin', 'agents.sections.your', 'agents.actions.new'],
  },
  {
    path: '/skills',
    headingKey: 'skills.title',
    expectStrings: ['skills.filter.all', 'skills.filter.seed', 'skills.reload'],
  },
  {
    path: '/workers',
    headingKey: 'workers.title',
    expectStrings: ['workers.cols.name', 'workers.cols.schedule', 'workers.actions.runNow'],
  },
  {
    path: '/insights',
    headingKey: 'insights.title',
    expectStrings: ['insights.trajectoriesTitle', 'insights.summariesTitle', 'insights.priorsTitle'],
  },
  {
    path: '/goap',
    headingKey: 'goap.title',
    expectStrings: ['goap.fields.start', 'goap.fields.goal', 'goap.actions.plan'],
  },
  {
    path: '/prompt-bundles',
    headingKey: 'promptBundles.title',
    expectStrings: ['promptBundles.cols.bundleKey', 'promptBundles.cols.model'],
  },
  {
    path: '/',
    expectStrings: ['topBar.missionControl', 'navigation.projects'],
  },
  {
    path: '/chat',
    expectStrings: ['navigation.teamChat'],
  },
];

test.describe('i18n: page strings match locale', () => {
  for (const { path, headingKey, expectStrings } of PAGES) {
    test(`${path}: visible strings match the active locale`, async ({ page }, testInfo) => {
      const lang = testInfo.project.metadata.lang as 'en' | 'de';
      await setLang(page, lang);
      await page.goto(path);
      await page.locator('[data-testid="sidebar-mission-control"]').waitFor();

      if (headingKey) {
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(tt(lang, headingKey));
      }
      for (const key of expectStrings) {
        const expected = tt(lang, key);
        await expect(
          page.getByText(expected, { exact: false }).first(),
          `key=${key} expected="${expected}" not visible on ${path} in ${lang}`,
        ).toBeVisible();
      }
    });
  }
});
