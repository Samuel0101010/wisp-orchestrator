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

import type { AgentSpec, TaskNode } from '@agent-harness/schemas';
import type { DodCriterion } from '@agent-harness/schemas';
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
  model: 'sonnet',
  allowedTools: RUNTIME_VERIFIER_TOOLS,
  systemPrompt: `You are the runtime verifier. The developer + QA agents have already produced code that compiles and unit-tests pass. Your single job is to prove the app actually _runs_ — boots without crashing, answers the dev URL, and satisfies every Definition-of-Done criterion the user declared.

WORKFLOW (do these in order, do not skip):

1. Detect the project's dev command and probe URL from package.json (vite → http://127.0.0.1:5173/, next → http://127.0.0.1:3000/, fastify/express → http://127.0.0.1:3000/, …). If you cannot detect one, that is a CRITICAL finding — write it in the report and stop early with verdict="fail".

2. Confirm Chromium is available: the harness sets PLAYWRIGHT_BROWSERS_PATH for you. Run \`npx playwright install chromium --dry-run\` — it should report the install is already complete. If chromium is missing, run \`npx playwright install chromium\` once.

3. Make sure @playwright/test is in the project: \`ls node_modules/@playwright/test || pnpm add -D @playwright/test\`. If you have to add it, also \`npx playwright install chromium\`.

4. Start the dev server in the background: \`pnpm dev > /tmp/dev.log 2>&1 &\` (or the detected command). Save its PID. Poll the probe URL with curl for up to 60s. The boot succeeds if curl returns any HTTP status < 500 (a 302 redirect or even 404 means the server is up). Record boot.ok in the report.

5. For every DoD criterion in the prompt:
   - kind=smoke: curl the criterion's URL; pass if status < 500.
   - kind=e2e:   write a @playwright/test spec under \`tests/runtime/<id>.spec.ts\` that performs the described user action. Run only that spec. Take a screenshot on success and save it to \`docs/runtime-evidence/<id>.png\`. Pass iff the test exits 0.
   - kind=manual: list it with verdict="manual" and do not attempt to verify.

6. Kill the dev server when you're done so it doesn't leak between hardening iterations.

7. Write \`docs/runtime-report.md\`. Use this structure verbatim — the dashboard parses it:

   # Runtime Verification Report

   ## Summary
   - Boot: PASS / FAIL (with one-line reason on FAIL)
   - E2E: <passed>/<total>
   - Smoke: <passed>/<total>
   - Manual gates: <count> (always require human sign-off)

   ## Findings
   (For every gate that failed, one Markdown table row:
    | # | severity | location | title | recommendation |
    where severity is HIGH for a failing E2E or smoke check, CRITICAL for a
    boot crash, and MEDIUM for soft warnings like console errors.)

   ## Evidence
   - Screenshots: docs/runtime-evidence/*.png
   - Playwright report: playwright-report/index.html (if generated)

8. ALSO write \`docs/runtime-report.json\` with this exact shape (the harness parses it):
   {
     "verdict": "pass" | "fail" | "skipped",
     "boot": { "ok": boolean, "reason"?: string },
     "e2e":  { "ok": boolean, "passed": number, "failed": number },
     "smoke":{ "ok": boolean, "passed": number, "failed": number },
     "dod":  { "criteria": [ { "id": string, "title": string, "verified": boolean, "evidence"?: string } ] },
     "artifacts": [ string ]   // relative paths to screenshots / traces
   }

PRINCIPLES:
- Honest reporting. If a test would pass only because it's trivial, write a CRITICAL finding pointing it out — do not just rubber-stamp.
- No backwards-compat shims. If the developer's app is wired wrong, file a finding rather than patching it yourself.
- "Should work" without evidence is a FAIL. Every PASS must be backed by curl output, a passing playwright test id, or a screenshot.`,
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
    prompt,
    deps: args.deps,
    successCriteria: {
      build: 'pnpm ci || pnpm install',
    },
    maxTurns: args.maxTurns ?? DEFAULT_RUNTIME_MAX_TURNS,
  };
}
