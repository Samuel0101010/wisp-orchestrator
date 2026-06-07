/**
 * Wave 3 — extended e2e coverage for v1.6.0.
 *
 *   Spec 1: Chat feature in depth (full-page /chat route — ChatRoute).
 *   Spec 2: Manager-agent project happy-path (deeper than smoke.spec.ts).
 *
 * Both specs run only on chromium-en (i18n is already covered by i18n.spec.ts).
 * Boots through the shared Playwright webServer with WISP_MOCK_CLI=1, so the
 * planner + each role-task subprocess are routed through `mock-claude.mjs`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { setLang } from './helpers/set-lang';
import { tt } from './helpers/locator-by-key';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Helper: screenshot on step failure, then re-throw so the test reports cleanly.
async function withStep<T>(page: Page, n: number, label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const file = path.join(HERE, `wave3-chat-step-${n}-failure.png`);
    try {
      await page.screenshot({ path: file, fullPage: true });
      console.error(`[wave3] step ${n} (${label}) failed — screenshot @ ${file}`);
    } catch {
      /* screenshot best-effort */
    }
    throw err;
  }
}

test.describe('Wave 3 — Chat coverage', () => {
  test('chat: nav → new thread → send → participants', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium-en',
      'wave3 runs only on chromium-en (i18n covered elsewhere)',
    );
    test.setTimeout(90_000);
    const lang = testInfo.project.metadata.lang as 'en' | 'de';

    // Step 1: setLang + visit root.
    await withStep(page, 1, 'setLang + goto /', async () => {
      await setLang(page, lang);
      // Pre-ack first-run modal in case it appears.
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem('agent-harness:first-run-ack-v1', '1');
        } catch {
          /* ignore */
        }
      });
      await page.goto('/');
    });

    // Step 2: sidebar visible.
    await withStep(page, 2, 'sidebar mission-control visible', async () => {
      await expect(page.getByTestId('sidebar-mission-control')).toBeVisible({ timeout: 20_000 });
    });

    // Step 3: click Chat nav → URL becomes /chat.
    await withStep(page, 3, 'click sidebar Chat → /chat', async () => {
      await page.getByTestId('sidebar-chat').click();
      await expect(page).toHaveURL(/\/chat$/, { timeout: 10_000 });
    });

    // Step 4: confirm the team chat page mounted. The full-page ChatRoute pins
    // the manager (Marcus) — there is no <select> on this page. Instead we
    // assert the participants pane header is visible.
    await withStep(page, 4, 'chat page mounted with manager present', async () => {
      // Wait for either the threads sidebar title or participants title.
      await expect(page.getByText(tt(lang, 'chat.sidebar.title'), { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByText(tt(lang, 'chat.participants.title'), { exact: true }),
      ).toBeVisible();
    });

    // Step 5: nothing to do — manager (Marcus) is implicitly selected.

    // Step 6: click the "new conversation" IconButton → a new thread appears.
    await withStep(page, 6, 'create new thread', async () => {
      // aria-label = tooltips.newThread ("New conversation").
      await page
        .getByRole('button', { name: tt(lang, 'tooltips.newThread') })
        .first()
        .click();
      // Header should now show defaultTitle since thread was just created.
      await expect(
        page.getByText(tt(lang, 'chat.header.defaultTitle'), { exact: false }),
      ).toBeVisible({ timeout: 10_000 });
    });

    // Step 7: composer visible.
    await withStep(page, 7, 'composer visible', async () => {
      await expect(
        page.getByRole('textbox', { name: tt(lang, 'chat.composer.ariaLabel') }),
      ).toBeVisible({ timeout: 10_000 });
    });

    // Step 8 + 9: type message + send via the send IconButton.
    const userMessage = 'hello manager, list 3 things you can do';
    await withStep(page, 8, 'type + send message', async () => {
      const composer = page.getByRole('textbox', { name: tt(lang, 'chat.composer.ariaLabel') });
      await composer.click();
      await composer.fill(userMessage);
      await page.getByRole('button', { name: tt(lang, 'tooltips.sendMessage') }).click();
      // The user's message should appear in the transcript. In mock mode the
      // assistant reply may or may not be a meaningful string — we only assert
      // on our own message round-trip. The text echoes in the thread title +
      // header + transcript bubble, so .first() is sufficient.
      await expect(page.getByText(userMessage, { exact: false }).first()).toBeVisible({
        timeout: 15_000,
      });
    });

    // Step 10: participants pane is the right-most aside — already visible
    // (always-on) for the full-page ChatRoute. Just confirm at least one
    // participant row (the manager) is rendered.
    await withStep(page, 10, 'participants pane shows the manager', async () => {
      // The "permanent" footer mentions Marcus — a stable signal that the
      // pane has hydrated.
      await expect(
        page.getByText(tt(lang, 'chat.participants.permanent'), { exact: false }),
      ).toBeVisible({ timeout: 10_000 });
    });

    // Step 11: open the AddMember dialog, close it.
    await withStep(page, 11, 'open + close AddMember dialog', async () => {
      await page.getByRole('button', { name: tt(lang, 'tooltips.addMember') }).click();
      const dialogTitle = page.getByText(tt(lang, 'chat.addMember.title'), { exact: true });
      await expect(dialogTitle).toBeVisible({ timeout: 5_000 });
      // Scope the close click to the dialog header (the dialog renders its own
      // <button>close</button>). Avoid colliding with any other close buttons.
      const dialog = page
        .locator('div')
        .filter({ hasText: tt(lang, 'chat.addMember.title') })
        .last();
      await dialog
        .getByRole('button', { name: tt(lang, 'chat.addMember.close'), exact: true })
        .click();
      await expect(dialogTitle).toHaveCount(0, { timeout: 5_000 });
    });

    // Step 12: navigate away, then back to /chat. We only assert the route
    // round-trips cleanly — selected-thread persistence across remount is a
    // separate UX decision (currently ChatRoute does not re-select the last
    // thread on remount), so we don't assert message visibility here.
    await withStep(page, 12, 'navigate away and back', async () => {
      await page.getByTestId('sidebar-mission-control').click();
      await expect(page).toHaveURL(/\/$/);
      await page.getByTestId('sidebar-chat').click();
      await expect(page).toHaveURL(/\/chat$/);
    });
  });
});

test.describe('Wave 3 — Manager-agent project happy-path', () => {
  test('project: create → team → plan → lock & run → done', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-en', 'wave3 runs only on chromium-en');
    test.setTimeout(180_000);
    const lang = testInfo.project.metadata.lang as 'en' | 'de';

    const REPO_PATH = process.env.WISP_E2E_REPO_PATH;
    if (!REPO_PATH) {
      throw new Error('WISP_E2E_REPO_PATH not set — invoke via `pnpm test:e2e`.');
    }

    // Pre-ack first-run ToS modal.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('agent-harness:first-run-ack-v1', '1');
      } catch {
        /* ignore */
      }
    });

    await setLang(page, lang);
    await page.goto('/');
    await expect(page.getByTestId('sidebar-mission-control')).toBeVisible({ timeout: 20_000 });

    // Open the new-project dialog.
    // Scope to the sidebar — Wisp Home page also has a hero "New project".
    await page
      .getByTestId('sidebar')
      .getByRole('button', { name: tt(lang, 'navigation.newProject') })
      .click();
    await expect(page.getByRole('heading', { name: tt(lang, 'newProject.title') })).toBeVisible();

    // Fill name + goal + repo. Default template is fine.
    await page.getByLabel(tt(lang, 'newProject.fields.name')).fill('wave3-test');
    await page
      .getByLabel(tt(lang, 'newProject.fields.goal'))
      .fill('Build a static site that lists 5 fruits');
    await page.getByLabel(tt(lang, 'newProject.fields.repoPath')).fill(REPO_PATH);

    await page.getByRole('button', { name: tt(lang, 'buttons.create') }).click();

    // After create the UI lands on the project overview (Brief tab); continue
    // into the Team Builder (a separate route).
    await expect(page).toHaveURL(/\/projects\/[^/]+$/, { timeout: 15_000 });
    const url = page.url();
    const projectId = url.match(/\/projects\/([^/]+)$/)?.[1];
    if (!projectId) throw new Error(`could not extract projectId from URL: ${url}`);
    await page.goto(`${url}/teams`);

    // Default team (architect/developer/qa) is pre-populated.
    await expect(
      page.getByRole('heading', { name: tt(lang, 'teamBuilder.title'), level: 1 }),
    ).toBeVisible();
    await expect(page.getByTestId('badge-architect')).toBeVisible();
    await expect(page.getByTestId('badge-developer')).toBeVisible();
    await expect(page.getByTestId('badge-qa')).toBeVisible();

    // Save Team.
    await page.getByRole('button', { name: tt(lang, 'buttons.saveTeam') }).click();
    await expect(page.getByText(tt(lang, 'teamBuilder.toasts.saved')).first()).toBeVisible({
      timeout: 10_000,
    });

    // Navigate to plan editor via the "Generate Plan" button.
    await expect(page.getByRole('button', { name: tt(lang, 'buttons.generatePlan') })).toBeVisible({
      timeout: 10_000,
    });

    // v1.9 brief-gate: plan generation requires a finalised brief (briefReady=1).
    // The happy-path test skips the interview UI, so finalise the brief directly
    // via the API before clicking Generate Plan, otherwise the server returns 412.
    const finalizeRes = await page.request.post(`/api/projects/${projectId}/interview/finalize`);
    expect(finalizeRes.ok(), `finalize brief: ${finalizeRes.status()}`).toBeTruthy();

    // The Generate Plan button is now disabled until the cached interview state
    // reflects the finalised brief. The API finalize above doesn't touch React
    // Query's cache, so reload to refetch and enable the button.
    await page.reload();
    await expect(page.getByRole('button', { name: tt(lang, 'buttons.generatePlan') })).toBeEnabled({
      timeout: 10_000,
    });

    await page.getByRole('button', { name: tt(lang, 'buttons.generatePlan') }).click();

    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/plan$`), { timeout: 30_000 });

    // Plan tasks list visible — assert the 3 role labels appear.
    await expect(page.getByText('architect', { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('developer', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('qa', { exact: false }).first()).toBeVisible();

    const draftLabel = tt(lang, 'status.draft');
    const lockedLabel = tt(lang, 'status.locked');
    await expect(page.getByTestId('plan-status')).toContainText(
      new RegExp(`${draftLabel}|${lockedLabel}`, 'i'),
      { timeout: 30_000 },
    );

    // Lock & Run.
    await page.getByRole('button', { name: tt(lang, 'buttons.lockAndRun') }).click();
    const confirmDialog = page.getByRole('dialog', {
      name: tt(lang, 'planEditor.lockDialog.title'),
    });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole('button', { name: tt(lang, 'buttons.lockAndRun') }).click();

    // Land on /run/:runId.
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/run/[^/]+$`), {
      timeout: 30_000,
    });
    const runUrl = page.url();
    const runId = runUrl.match(/\/run\/([^/]+)$/)?.[1];
    expect(runId, 'runId should be present in URL').toBeTruthy();

    // Wait for status to reach completed/done/success.
    const completedLabel = tt(lang, 'status.completed');
    const doneLabel = tt(lang, 'status.done');
    const successLabel = tt(lang, 'status.success');
    await expect(page.getByTestId('run-status')).toContainText(
      new RegExp(`${completedLabel}|${doneLabel}|${successLabel}`, 'i'),
      { timeout: 120_000 },
    );

    // Kanban DONE column has at least one task card.
    const doneColumn = page.getByTestId('kanban-column-done');
    await expect(doneColumn).toBeVisible();
    // The smoke spec asserts all 3 task-card-architect/developer/qa testids land
    // in done. Here we relax to "at least one task in done" per spec, then also
    // assert all three (the mock CLI flows the full plan).
    await expect(doneColumn.locator('[data-testid^="task-card-"]').first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(doneColumn.getByTestId('task-card-architect')).toBeVisible({ timeout: 10_000 });
    await expect(doneColumn.getByTestId('task-card-developer')).toBeVisible({ timeout: 10_000 });
    await expect(doneColumn.getByTestId('task-card-qa')).toBeVisible({ timeout: 10_000 });

    // Events log assertion: the RunView UI doesn't expose a literal events
    // panel with a testid, so we read the events from the API directly. In
    // mock mode any completed run should have plenty (run.start, task.start,
    // task.completed × 3, run.completed at minimum).
    const eventsRes = await page.request.get(`/api/runs/${runId}/events`);
    expect(eventsRes.ok(), 'events endpoint should return 2xx').toBe(true);
    const eventsBody = (await eventsRes.json()) as { events?: unknown[] };
    expect(Array.isArray(eventsBody.events)).toBe(true);
    expect((eventsBody.events ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
