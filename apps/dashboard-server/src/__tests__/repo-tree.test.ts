import './setup.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildCodebaseSection,
  ensureWispExcluded,
  generateRepoTree,
  MAX_CODEBASE_SECTION_CHARS,
  writeRepoMapToWorktree,
} from '../orchestrator/repo-tree.js';

const tmpDirs: string[] = [];

/** Fresh fixture dir, auto-cleaned after the suite. */
function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-repo-tree-'));
  tmpDirs.push(dir);
  return dir;
}

/** Write `files` (repo-relative, /-separated) as empty-ish files under root. */
function seed(root: string, files: string[]): void {
  for (const rel of files) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `// ${rel}\n`, 'utf8');
  }
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('generateRepoTree', () => {
  it('renders a deterministic, dirs-first, alphabetical, exact tree', () => {
    const root = makeTmp();
    seed(root, ['src/app/main.ts', 'src/index.ts', 'README.md']);
    const expected = 'src/\n  app/\n    main.ts\n  index.ts\nREADME.md';
    expect(generateRepoTree(root)).toBe(expected);
    // Determinism: a second walk yields the identical string.
    expect(generateRepoTree(root)).toBe(expected);
  });

  it('uses forward slashes only — no backslash ever appears in the output', () => {
    const root = makeTmp();
    seed(root, ['src/deep/nested/file.ts', 'src/other.ts']);
    const out = generateRepoTree(root);
    expect(out).not.toBeNull();
    expect(out).not.toContain('\\');
  });

  it('caps entries per directory with a "… (+N more)" marker', () => {
    const root = makeTmp();
    seed(root, ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
    const out = generateRepoTree(root, { maxEntriesPerDir: 3 });
    expect(out).toContain('a.ts');
    expect(out).toContain('c.ts');
    expect(out).not.toContain('d.ts');
    expect(out).toContain('… (+2 more)');
  });

  it('appends the global truncation marker when maxTotalEntries is exceeded', () => {
    const root = makeTmp();
    seed(root, ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']);
    const out = generateRepoTree(root, { maxTotalEntries: 3 });
    expect(out).toContain('… [tree truncated]');
    expect(out).not.toContain('f.ts');
  });

  it('respects maxChars as a hard cap including the truncation marker', () => {
    const root = makeTmp();
    seed(
      root,
      Array.from({ length: 40 }, (_, i) => `file-${String(i).padStart(2, '0')}.ts`),
    );
    const out = generateRepoTree(root, { maxChars: 80, maxEntriesPerDir: 100 });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(80);
    expect(out).toContain('… [tree truncated]');
  });

  it('excludes node_modules / .git / dist by name', () => {
    const root = makeTmp();
    seed(root, ['node_modules/pkg/index.js', '.git/HEAD', 'dist/bundle.js', 'src/index.ts']);
    const out = generateRepoTree(root);
    expect(out).toContain('src/');
    expect(out).toContain('index.ts');
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('.git');
    expect(out).not.toContain('dist');
    expect(out).not.toContain('HEAD');
  });

  it('excludes a .git FILE by name (linked-worktree shape)', () => {
    const root = makeTmp();
    seed(root, ['src/index.ts']);
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: ../some/main/.git/worktrees/wt\n', 'utf8');
    const out = generateRepoTree(root);
    expect(out).toContain('index.ts');
    expect(out).not.toContain('.git');
  });

  it('returns null for a scaffold-only repo (README.md + docs/PRD.md)', () => {
    const root = makeTmp();
    seed(root, ['README.md', 'docs/PRD.md']);
    expect(generateRepoTree(root)).toBeNull();
  });

  it('returns null for a .git-only repo and for a nonexistent root', () => {
    const root = makeTmp();
    seed(root, ['.git/HEAD']);
    expect(generateRepoTree(root)).toBeNull();
    expect(generateRepoTree(path.join(root, 'does-not-exist'))).toBeNull();
  });

  it('returns a tree once the first real file exists next to scaffold artifacts', () => {
    const root = makeTmp();
    seed(root, ['README.md', '.gitignore', 'LICENSE', 'docs/PRD.md', 'docs/project-state.md']);
    expect(generateRepoTree(root)).toBeNull();
    seed(root, ['src/index.ts']);
    const out = generateRepoTree(root);
    expect(out).not.toBeNull();
    expect(out).toContain('src/');
    expect(out).toContain('index.ts');
  });

  it('skips symlinked entries (cycle/junction safety)', () => {
    const root = makeTmp();
    seed(root, ['real/file.ts', 'src/index.ts']);
    const linkPath = path.join(root, 'linked');
    try {
      // 'junction' works without admin privileges on Windows; the type arg is
      // ignored on POSIX. If the test env still can't create links, skip the
      // assertion rather than fail the suite (contract-sanctioned).
      fs.symlinkSync(path.join(root, 'real'), linkPath, 'junction');
    } catch {
      return; // symlink creation not permitted in this env — skip
    }
    if (!fs.lstatSync(linkPath).isSymbolicLink()) return; // not reported as a link — skip
    const out = generateRepoTree(root);
    expect(out).toContain('real/');
    expect(out).not.toContain('linked');
  });

  it('respects maxDepth — directories below the cutoff are not expanded', () => {
    const root = makeTmp();
    seed(root, ['a/b/c/deep.ts', 'a/top.ts']);
    const out = generateRepoTree(root, { maxDepth: 2 });
    expect(out).toContain('a/');
    expect(out).toContain('b/');
    expect(out).toContain('top.ts');
    expect(out).not.toContain('c/');
    expect(out).not.toContain('deep.ts');
  });
});

describe('buildCodebaseSection', () => {
  it('returns null when the tree is null (scaffold-only repo)', () => {
    const root = makeTmp();
    seed(root, ['README.md', 'docs/PRD.md']);
    expect(buildCodebaseSection(root)).toBeNull();
  });

  it('renders the exact fixed text + fenced tree, hard-capped at 1600 chars', () => {
    const root = makeTmp();
    seed(
      root,
      Array.from({ length: 60 }, (_, i) => `src/module-${String(i).padStart(2, '0')}/index.ts`),
    );
    const out = buildCodebaseSection(root);
    expect(out).not.toBeNull();
    expect(
      out!.startsWith(
        '## Existing codebase\n\n' +
          'This project already exists. MODIFY the existing code; do NOT scaffold a new project; ' +
          're-use the existing structure, dependencies and conventions. A fuller file map is at ' +
          '.wisp/repo-map.md in your working directory.\n\n```\n',
      ),
    ).toBe(true);
    expect(out!.endsWith('\n```')).toBe(true);
    expect(out!.length).toBeLessThanOrEqual(MAX_CODEBASE_SECTION_CHARS);
    expect(out).toContain('src/');
  });

  it('keeps a backtick-named file INSIDE the fence (CommonMark-longer fence)', () => {
    const root = makeTmp();
    seed(root, ['src/index.ts']);
    fs.writeFileSync(path.join(root, '```'), '// fence-escape attempt\n', 'utf8');
    const out = buildCodebaseSection(root);
    expect(out).not.toBeNull();
    const lines = out!.split('\n');
    const closingFence = lines[lines.length - 1];
    // Fence must be LONGER than the 3-backtick run in the filename.
    expect(closingFence).toMatch(/^`{4,}$/);
    expect(closingFence.length).toBeGreaterThan(3);
    const open = lines.indexOf(closingFence);
    const close = lines.lastIndexOf(closingFence);
    const nameIdx = lines.indexOf('```'); // the verbatim filename line
    expect(nameIdx).toBeGreaterThan(open);
    expect(nameIdx).toBeLessThan(close);
  });
});

describe('ensureWispExcluded', () => {
  it('appends .wisp/ once, preserves prior content, and is idempotent', () => {
    const root = makeTmp();
    const infoDir = path.join(root, '.git', 'info');
    fs.mkdirSync(infoDir, { recursive: true });
    fs.writeFileSync(path.join(infoDir, 'exclude'), '# existing\nfoo.txt\n', 'utf8');
    ensureWispExcluded(root);
    ensureWispExcluded(root);
    const content = fs.readFileSync(path.join(infoDir, 'exclude'), 'utf8');
    expect(content).toContain('# existing\nfoo.txt\n');
    expect(content.match(/^\.wisp\/$/gm)).toHaveLength(1);
  });

  it('creates .git/info/exclude when missing', () => {
    const root = makeTmp();
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    ensureWispExcluded(root);
    const content = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(content).toBe('.wisp/\n');
  });

  it('silently no-ops when .git is a file (linked worktree) or missing', () => {
    const root = makeTmp();
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: ../main/.git/worktrees/wt\n', 'utf8');
    expect(() => ensureWispExcluded(root)).not.toThrow();
    // Unchanged — never rewrites a gitdir pointer file.
    expect(fs.readFileSync(path.join(root, '.git'), 'utf8')).toBe(
      'gitdir: ../main/.git/worktrees/wt\n',
    );
    expect(() => ensureWispExcluded(makeTmp())).not.toThrow();
  });
});

describe('writeRepoMapToWorktree', () => {
  it('writes .wisp/repo-map.md with header + fenced tree for a real repo', () => {
    const root = makeTmp();
    seed(root, ['src/index.ts', 'README.md']);
    writeRepoMapToWorktree(root);
    const mapPath = path.join(root, '.wisp', 'repo-map.md');
    const content = fs.readFileSync(mapPath, 'utf8');
    expect(
      content.startsWith(
        '# Repo map\n\nGenerated by WISP at worktree creation. Not committed (git-excluded).\n\n```\n',
      ),
    ).toBe(true);
    expect(content).toContain('index.ts');
  });

  it('keeps a backtick-named file INSIDE the repo-map fence (CommonMark-longer fence)', () => {
    const root = makeTmp();
    seed(root, ['src/index.ts']);
    fs.writeFileSync(path.join(root, '```'), '// fence-escape attempt\n', 'utf8');
    writeRepoMapToWorktree(root);
    const content = fs.readFileSync(path.join(root, '.wisp', 'repo-map.md'), 'utf8');
    const lines = content.trimEnd().split('\n');
    const closingFence = lines[lines.length - 1];
    expect(closingFence).toMatch(/^`{4,}$/);
    expect(closingFence.length).toBeGreaterThan(3);
    const open = lines.indexOf(closingFence);
    const close = lines.lastIndexOf(closingFence);
    const nameIdx = lines.indexOf('```');
    expect(nameIdx).toBeGreaterThan(open);
    expect(nameIdx).toBeLessThan(close);
  });

  it('no-ops on a scaffold-only worktree', () => {
    const root = makeTmp();
    seed(root, ['README.md', 'docs/PRD.md']);
    writeRepoMapToWorktree(root);
    expect(fs.existsSync(path.join(root, '.wisp'))).toBe(false);
  });
});
