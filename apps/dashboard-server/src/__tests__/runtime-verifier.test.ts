import './setup.js';
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_VERIFIER_ROLE,
  buildRuntimeVerifyNode,
  parseRuntimeReportJson,
} from '../orchestrator/runtime-verifier.js';
import { agentSpecSchema, taskNodeSchema } from '@agent-harness/schemas';
import type { DodCriterion } from '@agent-harness/schemas';

function criterion(over: Partial<DodCriterion> = {}): DodCriterion {
  return {
    id: over.id ?? 'dod-1',
    projectId: 'p',
    title: over.title ?? 'User can log in',
    kind: over.kind ?? 'e2e',
    specJson: over.specJson ?? { testFile: 'tests/runtime/login.spec.ts' },
    position: over.position ?? 0,
    createdAt: over.createdAt ?? new Date(),
  };
}

describe('RUNTIME_VERIFIER_ROLE', () => {
  it('matches the agentSpecSchema (kebab role, length-bounded prompt)', () => {
    const r = agentSpecSchema.safeParse(RUNTIME_VERIFIER_ROLE);
    expect(r.success).toBe(true);
  });

  it('explicitly allows Bash + Read + Write — the verifier has to spawn dev servers', () => {
    const tools = RUNTIME_VERIFIER_ROLE.allowedTools.join(',');
    expect(tools).toMatch(/Bash/);
    expect(tools).toMatch(/Read/);
    expect(tools).toMatch(/Write/);
  });
});

describe('buildRuntimeVerifyNode', () => {
  it('produces a TaskNode that validates against the planner schema', () => {
    const node = buildRuntimeVerifyNode({ deps: ['n-qa'], dodCriteria: [criterion()] });
    expect(taskNodeSchema.safeParse(node).success).toBe(true);
  });

  it('embeds every DoD criterion id + title into the prompt so the agent sees them', () => {
    const c1 = criterion({ id: 'dod-login', title: 'User can log in' });
    const c2 = criterion({ id: 'dod-cart', title: 'User can add item to cart', kind: 'smoke' });
    const node = buildRuntimeVerifyNode({ deps: ['n-qa'], dodCriteria: [c1, c2] });
    expect(node.prompt).toContain('dod-login');
    expect(node.prompt).toContain('User can log in');
    expect(node.prompt).toContain('dod-cart');
    expect(node.prompt).toContain('smoke');
  });

  it('embeds the detected dev command + probe URL when supplied', () => {
    const node = buildRuntimeVerifyNode({
      deps: ['n-qa'],
      dodCriteria: [],
      detected: { devCommand: 'pnpm dev', probeUrl: 'http://127.0.0.1:5173/', type: 'web-app' },
    });
    expect(node.prompt).toContain('pnpm dev');
    expect(node.prompt).toContain('http://127.0.0.1:5173/');
    expect(node.prompt).toContain('web-app');
  });

  it('falls back to a clear no-DoD note when the project declared no criteria', () => {
    const node = buildRuntimeVerifyNode({ deps: ['n-qa'], dodCriteria: [] });
    expect(node.prompt).toMatch(/no Definition-of-Done criteria/i);
  });
});

describe('parseRuntimeReportJson', () => {
  it('returns null on invalid JSON', () => {
    expect(parseRuntimeReportJson('{not json')).toBeNull();
  });

  it('returns null when the schema does not match (missing required keys)', () => {
    expect(parseRuntimeReportJson('{"verdict":"pass"}')).toBeNull();
  });

  it('accepts a minimal pass report with boot only', () => {
    const r = parseRuntimeReportJson(JSON.stringify({ verdict: 'pass', boot: { ok: true } }));
    expect(r?.verdict).toBe('pass');
    expect(r?.boot.ok).toBe(true);
  });

  it('accepts a full report with e2e + smoke + dod sections', () => {
    const r = parseRuntimeReportJson(
      JSON.stringify({
        verdict: 'fail',
        boot: { ok: true },
        e2e: { ok: false, passed: 3, failed: 1 },
        smoke: { ok: true, passed: 2, failed: 0 },
        dod: {
          criteria: [
            { id: 'dod-1', title: 'Login', verified: false },
            {
              id: 'dod-2',
              title: 'Cart',
              verified: true,
              evidence: 'docs/runtime-evidence/cart.png',
            },
          ],
        },
        artifacts: ['docs/runtime-evidence/cart.png'],
      }),
    );
    expect(r?.verdict).toBe('fail');
    expect(r?.e2e?.failed).toBe(1);
    expect(r?.dod?.criteria.length).toBe(2);
    expect(r?.dod?.criteria[1]?.verified).toBe(true);
  });
});
