/**
 * Self-healing chain — findings scanner.
 *
 * After every successful run we read the agent-written QA + security reports
 * from the result branch and extract any HIGH/CRITICAL findings. If any
 * remain, the run is "successful but not production-ready" and the runtime
 * spawns a follow-up hardening run with those findings baked into the goal.
 *
 * The scanner is intentionally regex-based, not LLM-based:
 *   * it has to be fast and deterministic (runs in the run-completed hot path)
 *   * the agent output format is stable — Markdown table rows + ### headers
 *     with bold severity tokens — and we control the agent prompts that
 *     produce it
 *   * any false positive just causes one extra hardening iteration, which
 *     the chain cap bounds
 *
 * Findings are detected from two signal sources, in priority order:
 *   1. Markdown table rows of the form
 *        | <n> | **HIGH** | <file:line> | <title> | <recommendation> |
 *      which both qa-engineer and security agents produce in their reports.
 *   2. ### / #### headers of the form
 *        ### Finding 7 — HIGH: navigation not locked to file://
 *      which agents fall back to when there's no tabular summary.
 *
 * Severities are normalised to one of: CRITICAL, HIGH, MEDIUM, LOW, INFO.
 * Callers usually filter to >= HIGH to decide whether a hardening run is
 * warranted.
 */

import { execa } from 'execa';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface Finding {
  /** Source file the finding came from, relative to the repo (e.g. docs/security-review.md). */
  source: string;
  severity: Severity;
  /** Short title or summary. Trimmed, max ~200 chars to keep prompts tight. */
  title: string;
}

const SEVERITY_ALIASES: Record<string, Severity> = {
  CRITICAL: 'CRITICAL',
  CRIT: 'CRITICAL',
  HIGH: 'HIGH',
  H: 'HIGH',
  MEDIUM: 'MEDIUM',
  MED: 'MEDIUM',
  M: 'MEDIUM',
  LOW: 'LOW',
  L: 'LOW',
  INFO: 'INFO',
  PASS: 'INFO',
};

const SEVERITY_TOKEN_RE = /\*\*(CRITICAL|HIGH|MEDIUM|LOW|INFO|PASS)\*\*/i;
const HEADER_FINDING_RE =
  /^#{2,4}\s+(?:Finding\s+\d+\s*[—\-:]\s*)?(?:\*\*)?(CRITICAL|HIGH|MEDIUM|LOW|INFO)(?:\*\*)?\s*[:\-—]\s*(.+?)\s*$/i;

function normaliseSeverity(raw: string): Severity | null {
  const key = raw.toUpperCase().trim();
  return SEVERITY_ALIASES[key] ?? null;
}

function clampTitle(s: string): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 197)}…` : cleaned;
}

/**
 * Extract findings from a single markdown document. Pure function; deals only
 * with the text. Does not deduplicate — the same finding listed both in the
 * summary table and the detailed section comes back twice (callers dedupe).
 */
export function parseFindings(markdown: string, source: string): Finding[] {
  const out: Finding[] = [];
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    // Skip table separators and obvious non-rows fast.
    if (line.startsWith('|---') || line.startsWith('| --')) continue;

    // Table-row form: | <n> | **HIGH** | <loc> | <title> | <reco> |
    if (line.startsWith('|') && SEVERITY_TOKEN_RE.test(line)) {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      const sevCell = cells.find((c) => SEVERITY_TOKEN_RE.test(c));
      if (sevCell) {
        const sev = normaliseSeverity(sevCell.replace(/\*\*/g, ''));
        if (sev) {
          // Title heuristic: the longest cell that's not the severity / location.
          const candidates = cells.filter((c) => c !== sevCell && c.length > 0 && !/^\d+$/.test(c));
          const title = candidates.sort((a, b) => b.length - a.length)[0] ?? '(no title)';
          out.push({ source, severity: sev, title: clampTitle(title) });
          continue;
        }
      }
    }

    // Header form: ### Finding 7 — HIGH: navigation not locked
    const headerMatch = HEADER_FINDING_RE.exec(line);
    if (headerMatch && headerMatch[1] && headerMatch[2]) {
      const sev = normaliseSeverity(headerMatch[1]);
      if (sev) {
        out.push({ source, severity: sev, title: clampTitle(headerMatch[2]) });
      }
    }
  }
  return out;
}

/**
 * De-duplicate findings: same source + severity + the first 8 words of the
 * normalised (lowercased, alphanumeric-only) title collapse to one row.
 * Preserves first occurrence so the order in the source markdown is retained.
 *
 * Agents commonly emit the same finding twice — once in the summary table
 * (one-line title) and once in a "### Detailed Findings" section with a
 * longer title that includes the short one as a prefix. The 8-word normalised
 * prefix catches both spellings as the same row.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    // Normalise: lowercase, drop punctuation, collapse whitespace, take the
    // first 40 chars. This makes a row from the summary table (short title)
    // collide with the same row from the detailed section (long title that
    // starts with the short one).
    const normalised = f.title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    const key = `${f.source}::${f.severity}::${normalised}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

const ACTIONABLE_SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM'];

/** Filter to severities that warrant a hardening run. CRITICAL+HIGH+MEDIUM by default. */
export function actionableFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => ACTIONABLE_SEVERITIES.includes(f.severity));
}

/** Scan paths we know the agents write to. Honestly: a stable, small set. */
export const DEFAULT_FINDING_SOURCES = ['docs/security-review.md', 'docs/qa-report.md'] as const;

export interface ScanRefArgs {
  repoPath: string;
  ref: string;
  sources?: readonly string[];
}

/**
 * Read each `source` from `repoPath` at `ref` via `git show ref:path` and
 * parse it. Missing files are silently skipped (a project that never wrote
 * a security review just produces no findings). Returns the de-duplicated
 * union across all sources.
 */
export async function scanRefForFindings(args: ScanRefArgs): Promise<Finding[]> {
  const sources = args.sources ?? DEFAULT_FINDING_SOURCES;
  const collected: Finding[] = [];
  for (const src of sources) {
    try {
      const { stdout } = await execa('git', ['show', `${args.ref}:${src}`], {
        cwd: args.repoPath,
      });
      collected.push(...parseFindings(stdout, src));
    } catch {
      // Source absent or ref unknown — skip.
    }
  }
  return dedupeFindings(collected);
}

/**
 * Format findings as a compact bullet list suitable for embedding inside a
 * hardening-run goal prompt. Groups by severity, then by source.
 */
export function formatFindingsForGoal(findings: Finding[]): string {
  if (findings.length === 0) return '';
  const order: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
  const lines: string[] = [];
  for (const sev of order) {
    const bucket = findings.filter((f) => f.severity === sev);
    if (bucket.length === 0) continue;
    lines.push(`**${sev}** (${bucket.length}):`);
    for (const f of bucket) {
      lines.push(`- [${f.source}] ${f.title}`);
    }
  }
  return lines.join('\n');
}
