import { describe, expect, it } from 'vitest';
import {
  parseFindings,
  dedupeFindings,
  actionableFindings,
  formatFindingsForGoal,
} from '../orchestrator/findings.js';

describe('parseFindings — markdown table rows', () => {
  it('extracts severity + title from the wertzeit-app security review table', () => {
    const md = `# Security Review

| # | Severity | Location | Finding | Recommendation |
|---|----------|----------|---------|----------------|
| 1 | **CRITICAL** | package.json | auto-updater: placeholder domain + no code signing | Replace placeholder URL; configure code signing |
| 2 | **HIGH** | preload.js | Generic invoke passthrough exposes entire channel whitelist | Replace with per-method typed wrappers |
| 7 | **LOW** | main.js | webSecurity not explicitly set | Add webSecurity: true |
| 10 | **PASS** | All files | No eval / new Function found | — |
`;
    const findings = parseFindings(md, 'docs/security-review.md');
    expect(findings).toHaveLength(4);
    expect(findings[0]).toMatchObject({
      source: 'docs/security-review.md',
      severity: 'CRITICAL',
      title: expect.stringContaining('auto-updater'),
    });
    expect(findings[1].severity).toBe('HIGH');
    expect(findings[2].severity).toBe('LOW');
    expect(findings[3].severity).toBe('INFO');
  });

  it('parses ### Finding N — HIGH: title headers (fallback form)', () => {
    const md = `## Detailed Findings

### Finding 1 — CRITICAL: auto-updater placeholder domain + no code signing

Body text here.

### Finding 7 — HIGH: navigation not locked to file://

More body.
`;
    const findings = parseFindings(md, 'docs/security-review.md');
    expect(findings.map((f) => f.severity)).toEqual(['CRITICAL', 'HIGH']);
    expect(findings[0].title).toContain('auto-updater');
    expect(findings[1].title).toContain('navigation not locked');
  });

  it('returns [] for markdown with no findings', () => {
    const md = '# Empty\n\nNothing to see here.\n';
    expect(parseFindings(md, 'docs/x.md')).toEqual([]);
  });

  it('ignores table separator rows so they do not become bogus findings', () => {
    const md = `| Severity | Title |
|----------|-------|
| **HIGH** | real finding |
`;
    const findings = parseFindings(md, 'docs/x.md');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('HIGH');
  });
});

describe('dedupeFindings', () => {
  it('collapses entries with the same (source, severity, prefix-of-title)', () => {
    const a = {
      source: 'docs/security-review.md',
      severity: 'HIGH' as const,
      title: 'IPC handlers trust renderer input — no validation',
    };
    const b = {
      source: 'docs/security-review.md',
      severity: 'HIGH' as const,
      title: 'IPC handlers trust renderer input — no validation (detail body)',
    };
    const c = {
      source: 'docs/security-review.md',
      severity: 'HIGH' as const,
      title: 'Different finding entirely',
    };
    const out = dedupeFindings([a, b, c]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(c);
  });
});

describe('actionableFindings', () => {
  it('keeps CRITICAL / HIGH / MEDIUM, drops LOW / INFO', () => {
    const xs = [
      { source: 'x', severity: 'CRITICAL' as const, title: 'a' },
      { source: 'x', severity: 'HIGH' as const, title: 'b' },
      { source: 'x', severity: 'MEDIUM' as const, title: 'c' },
      { source: 'x', severity: 'LOW' as const, title: 'd' },
      { source: 'x', severity: 'INFO' as const, title: 'e' },
    ];
    const result = actionableFindings(xs);
    expect(result.map((f) => f.severity)).toEqual(['CRITICAL', 'HIGH', 'MEDIUM']);
  });
});

describe('formatFindingsForGoal', () => {
  it('groups by severity in CRITICAL→HIGH→MEDIUM order and outputs bullet lines', () => {
    const xs = [
      { source: 's', severity: 'HIGH' as const, title: 'IPC validation' },
      { source: 's', severity: 'CRITICAL' as const, title: 'updater + signing' },
      { source: 's', severity: 'MEDIUM' as const, title: 'CSP connect-src' },
    ];
    const txt = formatFindingsForGoal(xs);
    expect(txt).toMatch(/\*\*CRITICAL\*\*[^]*\*\*HIGH\*\*[^]*\*\*MEDIUM\*\*/);
    expect(txt).toContain('updater + signing');
    expect(txt).toContain('IPC validation');
    expect(txt).toContain('CSP connect-src');
  });

  it('returns empty string for empty input', () => {
    expect(formatFindingsForGoal([])).toBe('');
  });
});
