import fs from 'node:fs';
import path from 'node:path';

/**
 * Repo-tree rendering for incremental builds (P2 Lane B).
 *
 * Existing projects need agents to MODIFY code instead of scaffolding from
 * scratch. This module renders a compact, deterministic file tree of the
 * project repo that the runtime injects into every agent prompt (see
 * `buildCodebaseSection`) and writes in fuller form into each worktree as
 * `.wisp/repo-map.md` (see `writeRepoMapToWorktree`).
 *
 * Everything here is best-effort: generation returns null on any fs error,
 * the writers are no-ops on failure — a broken tree must never fail a run.
 */

export interface RepoTreeOptions {
  maxChars?: number;
  maxDepth?: number;
  maxEntriesPerDir?: number;
  maxTotalEntries?: number;
}

const DEFAULT_MAX_CHARS = 3_500;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ENTRIES_PER_DIR = 30;
const DEFAULT_MAX_TOTAL_ENTRIES = 2_000;

// Excluded BY NAME at every level — never type-checked, because in a linked
// git worktree `.git` is a FILE (gitdir pointer), not a directory, and must
// still be excluded.
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  'coverage',
  '.wisp',
  '.harness-worktrees',
]);

// Scaffold artifacts: when, after exclusions, ONLY these files remain the
// repo is "effectively empty" (a fresh WISP project with just the rendered
// brief) and generateRepoTree returns null so fresh runs keep their
// scaffold-from-scratch prompts. Compared case-insensitively against
// /-normalized repo-relative paths.
const SCAFFOLD_ALLOWLIST = new Set([
  'readme.md',
  '.gitignore',
  'license',
  'docs/prd.md',
  'docs/project-state.md',
]);

const GLOBAL_TRUNCATION_MARKER = '… [tree truncated]';

// Total hard cap for the agent-prompt section (fixed text + fenced tree).
export const MAX_CODEBASE_SECTION_CHARS = 1_600;

const CODEBASE_SECTION_INTRO =
  'This project already exists. MODIFY the existing code; do NOT scaffold a new project; ' +
  're-use the existing structure, dependencies and conventions. A fuller file map is at ' +
  '.wisp/repo-map.md in your working directory.';

/** Deterministic code-unit sort — never locale-dependent. */
function byName(a: fs.Dirent, b: fs.Dirent): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Defensive: entry names never contain separators, but normalize anyway. */
function toForwardSlashes(name: string): string {
  return name.split(path.sep).join('/');
}

/**
 * Render an indented file tree of `rootPath`: dirs first (trailing '/'),
 * alphabetical, deterministic, forward slashes only. Returns null — never
 * throws — when the root is missing/unreadable or the repo is effectively
 * empty (only scaffold artifacts remain after exclusions).
 */
export function generateRepoTree(rootPath: string, opts?: RepoTreeOptions): string | null {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntriesPerDir = opts?.maxEntriesPerDir ?? DEFAULT_MAX_ENTRIES_PER_DIR;
  const maxTotalEntries = opts?.maxTotalEntries ?? DEFAULT_MAX_TOTAL_ENTRIES;
  try {
    if (!fs.statSync(rootPath).isDirectory()) return null;

    const lines: string[] = [];
    let used = 0;
    let totalEntries = 0;
    // Char/total-entry caps hit — renders the global truncation marker.
    let globalTruncated = false;
    // ANY entry hidden (per-dir cap, depth cutoff, global caps): the repo
    // holds more than what we rendered, so it cannot be scaffold-only.
    let sawNonScaffold = false;

    // Reserve the marker's length inside maxChars (same pattern as
    // brief-context.ts) so the final string never exceeds the cap.
    const budget = Math.max(0, maxChars - (GLOBAL_TRUNCATION_MARKER.length + 1));
    const tryPush = (line: string): boolean => {
      const cost = line.length + (lines.length > 0 ? 1 : 0); // +1 for the join '\n'
      if (used + cost > budget) {
        globalTruncated = true;
        return false;
      }
      lines.push(line);
      used += cost;
      return true;
    };

    const listVisible = (dir: string): fs.Dirent[] => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      // Skip symlinks (Windows junction/cycle safety) and excluded names.
      return entries.filter((e) => !e.isSymbolicLink() && !EXCLUDE_DIRS.has(e.name));
    };

    const walk = (dir: string, relPrefix: string, level: number): void => {
      const visible = listVisible(dir);
      const dirs = visible.filter((e) => e.isDirectory()).sort(byName);
      const files = visible.filter((e) => e.isFile()).sort(byName);
      const ordered = [...dirs, ...files];
      const shown = ordered.slice(0, maxEntriesPerDir);
      const hiddenCount = ordered.length - shown.length;
      if (hiddenCount > 0) sawNonScaffold = true;
      const indent = '  '.repeat(level - 1);
      for (const entry of shown) {
        if (globalTruncated) return;
        if (totalEntries >= maxTotalEntries) {
          globalTruncated = true;
          sawNonScaffold = true;
          return;
        }
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!tryPush(`${indent}${toForwardSlashes(entry.name)}/`)) return;
          totalEntries++;
          if (level < maxDepth) {
            walk(path.join(dir, entry.name), rel, level + 1);
          } else if (listVisible(path.join(dir, entry.name)).length > 0) {
            // Depth cutoff hides real content — repo is not scaffold-only.
            sawNonScaffold = true;
          }
        } else {
          if (!SCAFFOLD_ALLOWLIST.has(toForwardSlashes(rel).toLowerCase())) {
            sawNonScaffold = true;
          }
          if (!tryPush(`${indent}${toForwardSlashes(entry.name)}`)) return;
          totalEntries++;
        }
      }
      if (hiddenCount > 0 && !globalTruncated) {
        tryPush(`${indent}… (+${hiddenCount} more)`);
      }
    };

    walk(rootPath, '', 1);

    if (lines.length === 0) return null;
    if (!sawNonScaffold) return null; // scaffold artifacts only — effectively empty
    let out = lines.join('\n');
    if (globalTruncated) out += `\n${GLOBAL_TRUNCATION_MARKER}`;
    return out;
  } catch {
    return null;
  }
}

/**
 * CommonMark-correct code fence: a fence must be LONGER than any backtick run
 * inside the fenced text, else a file legally named e.g. ``` closes the fence
 * early and the remaining tree lines leak into the prompt as prose
 * (prompt-injection surface from imported repos). Names stay verbatim.
 */
function fencedBlock(text: string): string {
  let longestRun = 0;
  for (const match of text.matchAll(/`+/g)) {
    if (match[0].length > longestRun) longestRun = match[0].length;
  }
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${text}\n${fence}`;
}

function renderCodebaseSection(tree: string): string {
  return `## Existing codebase\n\n${CODEBASE_SECTION_INTRO}\n\n${fencedBlock(tree)}`;
}

/**
 * Build the "## Existing codebase" prompt section for the executing agents:
 * fixed modify-don't-scaffold instruction + a compact fenced tree. Null for
 * fresh/scaffold-only repos so the composer omits the section. Hard-capped
 * at MAX_CODEBASE_SECTION_CHARS including the fixed text.
 */
export function buildCodebaseSection(repoPath: string): string | null {
  const tree = generateRepoTree(repoPath, { maxChars: 1_200, maxDepth: 3 });
  if (tree === null) return null;
  let section = renderCodebaseSection(tree);
  if (section.length > MAX_CODEBASE_SECTION_CHARS) {
    // Defensive — 1200 tree chars + ~260 fixed chars fit, but if the fixed
    // text ever grows, re-truncate the tree to keep the hard cap.
    const treeBudget = MAX_CODEBASE_SECTION_CHARS - renderCodebaseSection('').length;
    const smaller = generateRepoTree(repoPath, { maxChars: Math.max(treeBudget, 0), maxDepth: 3 });
    section = renderCodebaseSection(smaller ?? '');
    if (section.length > MAX_CODEBASE_SECTION_CHARS) return null;
  }
  return section;
}

/**
 * Write a fuller file map into `<worktreePath>/.wisp/repo-map.md` so agents
 * can Read it on demand (the prompt section only carries the compact tree).
 * No-op for scaffold-only repos. Best-effort — never throws.
 */
export function writeRepoMapToWorktree(worktreePath: string): void {
  try {
    const tree = generateRepoTree(worktreePath, { maxChars: 8_000, maxDepth: 5 });
    if (tree === null) return;
    const wispDir = path.join(worktreePath, '.wisp');
    fs.mkdirSync(wispDir, { recursive: true });
    fs.writeFileSync(
      path.join(wispDir, 'repo-map.md'),
      `# Repo map\n\nGenerated by WISP at worktree creation. Not committed (git-excluded).\n\n${fencedBlock(tree)}\n`,
      'utf8',
    );
  } catch {
    // best-effort
  }
}

/**
 * Idempotently add `.wisp/` to `<repoPath>/.git/info/exclude` so the repo map
 * never shows up in `git status` / auto-commits. Creates the file (and info/
 * dir) when missing, only ever APPENDS — existing content is preserved. In a
 * linked worktree `.git` is a file; we silently no-op there (the main repo's
 * exclude already covers all of its worktrees). Never throws.
 */
export function ensureWispExcluded(repoPath: string): void {
  try {
    const gitPath = path.join(repoPath, '.git');
    if (!fs.statSync(gitPath).isDirectory()) return; // linked worktree — no-op
    const infoDir = path.join(gitPath, 'info');
    fs.mkdirSync(infoDir, { recursive: true });
    const excludePath = path.join(infoDir, 'exclude');
    let existing = '';
    try {
      existing = fs.readFileSync(excludePath, 'utf8');
    } catch {
      // missing file — will be created by the append below
    }
    if (existing.split(/\r?\n/).some((l) => l.trim() === '.wisp/')) return;
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(excludePath, `${sep}.wisp/\n`, 'utf8');
  } catch {
    // never throws
  }
}
