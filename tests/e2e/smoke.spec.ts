/**
 * Phase F1 — End-to-end smoke test.
 *
 * Boots the full dashboard (UI + API + WS on a single port via
 * HARNESS_SERVE_WEB=1) with HARNESS_MOCK_CLI=1 so the planner subprocess and
 * each role-task subprocess are routed through `mock-claude.mjs`. Drives the
 * UI through the full happy-path:
 *
 *   create project → save team → generate plan → lock & run → wait for done
 *
 * No real `claude` calls happen.
 */

import { expect, test } from '@playwright/test';

test.describe('Phase F1 smoke', () => {
  test('create project → team → plan → lock & run → done', async ({ page }) => {
    test.setTimeout(120_000);

    const REPO_PATH = process.env.HARNESS_E2E_REPO_PATH;
    if (!REPO_PATH) {
      throw new Error(
        'HARNESS_E2E_REPO_PATH not set. Did the Playwright config run? Invoke via `pnpm test:e2e` or `pnpm exec playwright test --config tests/e2e/playwright.config.ts`.',
      );
    }

    // Pre-acknowledge the first-run ToS modal so it doesn't intercept the
    // Lock & Run flow. addInitScript runs before any page script on every
    // navigation, so localStorage is seeded by the time React hydrates.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('agent-harness:first-run-ack-v1', '1');
      } catch {
        // localStorage may be unavailable in some contexts; ignore.
      }
    });

    // Step 1: Visit /. Sidebar visible.
    await page.goto('/');
    await expect(page.getByText('Agent Harness', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Projects', { exact: true })).toBeVisible();

    // Step 2: + New Project. Fill name/goal/repoPath. Submit.
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.getByText('New Project', { exact: true })).toBeVisible();

    await page.getByLabel('Name').fill('smoke-todo');
    await page.getByLabel('Goal').fill('Build a TypeScript CLI todo app');
    await page.getByLabel('Repo path').fill(REPO_PATH);

    await page.getByRole('button', { name: 'Create' }).click();

    // Step 3: navigate to /projects/<id>/teams. Defaults appear.
    await expect(page).toHaveURL(/\/projects\/[^/]+\/teams$/, { timeout: 15_000 });
    const url = page.url();
    const projectId = url.match(/\/projects\/([^/]+)\/teams$/)?.[1];
    if (!projectId) throw new Error(`could not extract projectId from URL: ${url}`);

    // "Team Builder" appears in both breadcrumbs and page heading; pin to the H1.
    await expect(page.getByRole('heading', { name: 'Team Builder', level: 1 })).toBeVisible();
    // Three role cards visible — we use the model badges as a stable signal.
    await expect(page.getByTestId('badge-architect')).toBeVisible();
    await expect(page.getByTestId('badge-developer')).toBeVisible();
    await expect(page.getByTestId('badge-qa')).toBeVisible();

    // Step 4: Save Team → toast → Generate Plan.
    await page.getByRole('button', { name: 'Save Team' }).click();
    // Toast renders both a visible title and a screen-reader status node, so
    // assert at least one match using `.first()` rather than the (strict-mode)
    // bare locator.
    await expect(page.getByText('Team saved').first()).toBeVisible({ timeout: 10_000 });

    // After Save, the team exists and the Generate Plan button appears.
    await expect(page.getByRole('button', { name: 'Generate Plan' })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: 'Generate Plan' }).click();

    // Step 5: navigate to /projects/<id>/plan, plan rendered with 3 nodes.
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/plan$`), { timeout: 30_000 });
    await expect(page.getByTestId('plan-status')).toContainText(/draft|locked/i, {
      timeout: 30_000,
    });

    // The PlanCanvas renders 3 nodes — assert each role label appears at least
    // once on the page.
    await expect(page.getByText('architect', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('developer', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('qa', { exact: false }).first()).toBeVisible();

    // Step 6: Lock & Run — opens a confirm dialog, then click the dialog's
    // "Lock & Run" button to actually start the run.
    await page.getByRole('button', { name: 'Lock & Run' }).click();
    const confirmDialog = page.getByRole('dialog', { name: /Lock plan and start run/i });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole('button', { name: 'Lock & Run' }).click();

    // Step 7: navigate to /projects/<id>/run/<runId>.
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/run/[^/]+$`), {
      timeout: 30_000,
    });
    const runUrl = page.url();
    const runId = runUrl.match(/\/run\/([^/]+)$/)?.[1];
    expect(runId, 'runId should be present in URL').toBeTruthy();

    // Step 8: Wait for run status to be `completed` (mock CLI runs all 3 tasks fast).
    await expect(page.getByTestId('run-status')).toContainText(/completed|done|success/i, {
      timeout: 90_000,
    });

    // Step 9: All 3 task cards in `Done` column.
    const doneColumn = page.getByTestId('kanban-column-done');
    await expect(doneColumn).toBeVisible();
    await expect(doneColumn.getByTestId('task-card-architect')).toBeVisible({ timeout: 10_000 });
    await expect(doneColumn.getByTestId('task-card-developer')).toBeVisible({ timeout: 10_000 });
    await expect(doneColumn.getByTestId('task-card-qa')).toBeVisible({ timeout: 10_000 });
  });
});
