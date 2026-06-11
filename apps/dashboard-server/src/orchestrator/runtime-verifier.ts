/**
 * runtime-verifier — the third layer of the v1.8 verification stack.
 *
 * The agent's job is to prove the app _runs_, not just compiles. Concretely:
 *   1. Detect the project's dev command + probe URL.
 *   2. Make sure Playwright + Chromium are available (the harness
 *      pre-populates PLAYWRIGHT_BROWSERS_PATH; the agent only has to
 *      verify, not install).
 *   3. Start the dev server in the background, poll the probe URL until
 *      it answers, then keep it running.
 *   4. For each DoD criterion of kind=e2e, write (or update) a
 *      @playwright/test spec under `tests/runtime/` and run it.
 *   5. For each criterion of kind=smoke, do a curl-style probe.
 *   6. For each criterion of kind=manual, list it in the report with
 *      verdict="manual" — the agent never auto-passes manual gates;
 *      they exist so the human approver sees the checklist.
 *   7. Emit `docs/runtime-report.md` (humans read this) AND
 *      `docs/runtime-report.json` (the harness reads this) with the
 *      structured verdict so release-gate can decide deterministically.
 *
 * Why both formats: the markdown is what the user sees in the dashboard
 * and what the findings parser scrapes for HIGH/CRITICAL rows so the
 * self-healing chain stays uniform. The JSON is the source of truth for
 * the release-gate's pass/fail decision — we don't want gate state to
 * depend on whether the agent remembered to bold the right word.
 *
 * The role config below is meant to live in a plan's team slot, exactly
 * like the existing self-healing security + qa-engineer roles. The
 * helper `buildRuntimeVerifyNode` returns a ready-to-insert TaskNode.
 */

import type { AgentSpec, TaskNode } from '@wisp/schemas';
import type { DodCriterion } from '@wisp/schemas';
import { z } from 'zod';

const RUNTIME_VERIFIER_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(npm:*, pnpm:*, npx:*, git:*, node:*, curl:*, sleep:*, kill:*, taskkill:*)',
];

export const RUNTIME_VERIFIER_ROLE: AgentSpec = {
  role: 'runtime-verifier',
  origin: 'system',
  model: 'sonnet',
  allowedTools: RUNTIME_VERIFIER_TOOLS,
  systemPrompt: `You are the runtime verifier. Code compiles + unit-tests pass. Prove the app actually _renders_ + satisfies every DoD criterion. HTTP 200 is NOT proof — a blank dark screen also returns 200.

WORKFLOW (in order, do not skip):

1. Detect dev command + probe URL from package.json (vite→:5173, next/fastify/express→:3000). Can't detect → CRITICAL, verdict="fail".

2. Chromium: \`npx playwright install chromium --dry-run\`; install if missing. \`ls node_modules/@playwright/test || pnpm add -D @playwright/test\`.

3. Start dev server in background; save PID; poll probe URL with curl up to 60s; boot ok = status < 500.

4. Write \`tests/runtime/_smoke.spec.ts\` — the React-aware smoke. For EVERY route reachable via a nav link / router config:
   (a) Attach \`page.on('pageerror', ...)\` AND \`page.on('console', m=>m.type()==='error')\` BEFORE the goto; collect into arrays.
   (b) page.goto(route), waitForLoadState('networkidle', timeout=5000).
   (c) Assert document.querySelector('main, [role=main], #root, body > div')?.textContent?.trim().length > 20 OR an h1/h2 with non-empty text exists. Empty body / dark wrapper = FAIL.
   (d) Pattern-match collected errors. ANY of these = FAIL severity CRITICAL:
       "Minified React error" (esp #185 = infinite render loop), "Maximum update depth exceeded", "Invariant Violation", "Uncaught ReferenceError", "Uncaught TypeError", "Hydration failed", "Cannot read properties of undefined".
   (e) Screenshot full-page per route → \`docs/runtime-screenshots/<route-slug>.png\`.
   (f) Total console-error count across all routes MUST be 0 — non-zero = HIGH finding.

5. For each DoD criterion:
   - smoke: curl URL; pass iff status<500 AND smoke spec for that route passed.
   - e2e: write \`tests/runtime/<id>.spec.ts\` with the same listener setup; screenshot \`docs/runtime-evidence/<id>.png\`; pass iff exit 0 AND zero pageerrors AND zero console errors.
   - manual: verdict="manual", do not auto-pass.

6. Kill dev server.

7. Write \`docs/runtime-report.md\` (the dashboard parses it):

   # Runtime Verification Report
   ## Summary
   - Boot: PASS/FAIL (one-line reason on fail)
   - E2E: <passed>/<total>
   - Smoke: <passed>/<total>
   - Manual gates: <count>
   ## Findings
   For each failing gate one row: | # | severity | location | title | recommendation |
   HIGH = failing E2E/smoke, CRITICAL = boot crash, MEDIUM = warnings.
   ## Evidence
   - Screenshots: docs/runtime-evidence/*.png + docs/runtime-screenshots/*.png
   - Playwright report: playwright-report/index.html

8. ALSO write \`docs/runtime-report.json\` (harness parses):
   { "verdict": "pass"|"fail"|"skipped",
     "boot": { "ok": bool, "reason"?: string },
     "e2e":  { "ok": bool, "passed": int, "failed": int },
     "smoke":{ "ok": bool, "passed": int, "failed": int },
     "dod":  { "criteria": [ { "id": string, "title": string, "verified": bool, "evidence"?: string } ] },
     "artifacts": [ string ] }

9. ALSO write \`docs/project-state.md\` so the NEXT iteration planner knows today's state. EXACT section headings (parsed verbatim):

   # Project State
   ## Implemented features
   - <bullet per shipped feature, present-tense, user-visible, ≤120 chars>
   ## Open todos
   - <bullets the planner still needs to drive>
   ## Known issues
   - <observed bugs / perf / a11y gaps>
   ## Architecture snapshot
   \`\`\`json
   { "topLevel": ["src/","tests/"], "stack": ["react","fastify"] }
   \`\`\`

   Only list what is true on this branch today. Architecture JSON ≤25 entries.

PRINCIPLES:
- Honest reporting. Rubber-stamping is a CRITICAL finding.
- "Should work" without evidence = FAIL. PASS requires curl output, playwright id, or screenshot.
- No backwards-compat shims — file findings instead of patching upstream code.`,
};

/**
 * Structured machine-readable verdict the agent writes to
 * docs/runtime-report.json. Mirrored by RuntimeReport in the DB.
 */
export const runtimeReportJsonSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'skipped', 'error']),
  boot: z.object({ ok: z.boolean(), reason: z.string().optional() }),
  e2e: z
    .object({
      ok: z.boolean(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .optional(),
  smoke: z
    .object({
      ok: z.boolean(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .optional(),
  dod: z
    .object({
      criteria: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          verified: z.boolean(),
          evidence: z.string().optional(),
        }),
      ),
    })
    .optional(),
  artifacts: z.array(z.string()).optional(),
});
export type RuntimeReportJson = z.infer<typeof runtimeReportJsonSchema>;

/**
 * Best-effort parser for the agent-emitted JSON. Returns null on any error
 * (missing file, bad JSON, schema mismatch). Callers treat null as
 * "verifier did not produce a usable report" — which is itself a FAIL signal.
 */
export function parseRuntimeReportJson(raw: string): RuntimeReportJson | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = runtimeReportJsonSchema.safeParse(parsed);
  return r.success ? r.data : null;
}

/**
 * Canonical React-aware Playwright smoke spec. The runtime-verifier agent
 * (and any test-dev producing e2e specs) is expected to drop a variant of
 * this file at `tests/runtime/_smoke.spec.ts` so we catch the failure modes
 * HTTP-200-on-boot misses: blank screens from layout bugs, infinite render
 * loops (React #185), uncaught reference/type errors, hydration failures.
 *
 * Exported so other prompts can quote it verbatim and so tests can assert
 * the canonical-smoke wording stays stable across releases.
 *
 * The file is intentionally framework-light: only `@playwright/test`. The
 * generating agent fills in the actual route list from the app's router
 * config — leaving `ROUTES` as a single `/` falls back to a single-route
 * smoke, which is still strictly better than "boot returned 200".
 */
export const RUNTIME_SMOKE_TEST_TEMPLATE = `import { test, expect, type ConsoleMessage } from '@playwright/test';

// Fill ROUTES from the app's router config. Leave '/' if the app is single-page.
const ROUTES: string[] = ['/'];

const FATAL_PATTERNS = [
  /Minified React error/i,
  /Maximum update depth exceeded/i,
  /Invariant Violation/i,
  /Uncaught ReferenceError/i,
  /Uncaught TypeError/i,
  /Hydration failed/i,
  /Cannot read propert(?:y|ies) of undefined/i,
];

for (const route of ROUTES) {
  test(\`renders \${route} without React/JS errors\`, async ({ page }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];

    // CRITICAL: attach listeners BEFORE goto, otherwise early-mount crashes
    // (the exact failure mode we're trying to catch) are missed.
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto(route);
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    // Non-empty content check. A blank dark wrapper (Tauri default body bg +
    // collapsed grid + early render crash) all return HTTP 200 but render
    // nothing meaningful. >20 chars of trimmed text content rules that out.
    const text = await page
      .locator('main, [role=main], #root, body > div')
      .first()
      .innerText({ timeout: 2000 })
      .catch(() => '');
    const hasHeading = await page.locator('h1, h2').first().isVisible().catch(() => false);
    expect(
      text.trim().length > 20 || hasHeading,
      \`route \${route} rendered empty (text="\${text.slice(0, 80)}", heading=\${hasHeading})\`,
    ).toBe(true);

    // Fatal-pattern check. Each match is its own failure for actionable output.
    for (const msg of [...pageErrors, ...consoleErrors]) {
      for (const pat of FATAL_PATTERNS) {
        expect(msg, \`fatal pattern matched on \${route}: \${msg}\`).not.toMatch(pat);
      }
    }

    // Zero-tolerance on console.error — surfaces silent issues like missing
    // keys, unhandled promise rejections, dev-only warnings escalated to error.
    expect(consoleErrors, \`console errors on \${route}: \${consoleErrors.join(' | ')}\`).toEqual([]);
    expect(pageErrors, \`pageerrors on \${route}: \${pageErrors.join(' | ')}\`).toEqual([]);

    // Evidence — full-page screenshot per route, slug-safe filename.
    const slug = route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root';
    await page.screenshot({ path: \`docs/runtime-screenshots/\${slug}.png\`, fullPage: true });
  });
}
`;

export interface BuildRuntimeVerifyNodeArgs {
  /** Stable id for the node — convention: `n-runtime-verify`. */
  id?: string;
  /** Dependencies (typically the QA node from the prior phase). */
  deps: string[];
  /** DoD criteria the verifier must prove. */
  dodCriteria: DodCriterion[];
  /** Optional detect-project-type result to embed in the prompt. */
  detected?: { devCommand: string | null; probeUrl: string | null; type: string };
  /** Turn budget. Conservative default; verification rarely needs many turns. */
  maxTurns?: number;
}

const DEFAULT_RUNTIME_MAX_TURNS = 60;

function renderCriteriaBlock(criteria: DodCriterion[]): string {
  if (criteria.length === 0) {
    return '_(no Definition-of-Done criteria declared — verify only boot + console health.)_';
  }
  const lines: string[] = ['| id | kind | title | spec |', '|---|---|---|---|'];
  for (const c of criteria) {
    const spec = JSON.stringify(c.specJson).replace(/\|/g, '\\|');
    lines.push(`| ${c.id} | ${c.kind} | ${c.title.replace(/\|/g, '\\|')} | ${spec} |`);
  }
  lines.push(
    '',
    'IMPORTANT: `docs/runtime-report.json` → `dod.criteria` MUST contain exactly one entry per criterion above, using the exact `id` from the table. An empty `dod.criteria` while criteria are declared is itself a CRITICAL reporting failure — the release gate cannot credit unattributed checks.',
  );
  return lines.join('\n');
}

export function buildRuntimeVerifyNode(args: BuildRuntimeVerifyNodeArgs): TaskNode {
  const detected = args.detected;
  const detectedBlock = detected
    ? `**Project type:** ${detected.type}\n**Suggested dev command:** \`${detected.devCommand ?? '(none detected — find one)'}\`\n**Suggested probe URL:** ${detected.probeUrl ?? '(none detected — find one)'}`
    : '_(project type not pre-detected — figure it out from package.json yourself.)_';

  const prompt = `Verify that the prior phase's deliverable actually runs in a real browser.

${detectedBlock}

## Definition of Done — criteria to evidence

${renderCriteriaBlock(args.dodCriteria)}

## Required outputs

1. \`docs/runtime-report.md\` — human-readable summary, see system prompt for the exact section structure.
2. \`docs/runtime-report.json\` — machine-readable verdict consumed by the harness's release-gate. Required keys: \`verdict\`, \`boot\`, plus \`e2e\` / \`smoke\` / \`dod\` as applicable. Schema is in the system prompt.
3. Screenshots and traces under \`docs/runtime-evidence/\`.

## Gates that decide your verdict
- Boot must succeed (probe URL answers < 500).
- Every smoke + e2e DoD criterion must pass with concrete evidence.
- Manual gates do not block your verdict — they're logged so the human approver can sign off.

Set \`verdict="pass"\` only when boot + every smoke + every e2e criterion passes. Otherwise \`"fail"\` with the specific reasons in findings.`;

  return {
    id: args.id ?? 'n-runtime-verify',
    role: 'runtime-verifier',
    origin: 'system',
    prompt,
    deps: args.deps,
    successCriteria: {
      build: 'pnpm ci || pnpm install',
    },
    maxTurns: args.maxTurns ?? DEFAULT_RUNTIME_MAX_TURNS,
  };
}
