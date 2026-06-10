import './setup.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { plans, projects, type Plan } from '@wisp/schemas';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';
import {
  buildPlannerRepoSections,
  loadLatestPreviousPlan,
} from '../orchestrator/planner-repo-context.js';

const FILLER = 'x'.repeat(80);

const SECTION_PREFIX =
  `## Existing repository\n\n` +
  `The repo already contains a built app. Plan changes ON TOP of this code — modify and extend. Do NOT plan re-scaffolding of the project skeleton.\n\n` +
  `### File tree (truncated)\n\`\`\`\n`;

function mkRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-prc-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

function makePlan(nodes: Plan['nodes']): Plan {
  return {
    goal: 'g',
    team: {
      roles: [
        { role: 'architect', model: 'opus', allowedTools: ['Read'], systemPrompt: `a ${FILLER}` },
        { role: 'developer', model: 'sonnet', allowedTools: ['Read'], systemPrompt: `d ${FILLER}` },
      ],
    },
    nodes,
    edges: [],
  };
}

const tmpDirs: string[] = [];

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('buildPlannerRepoSections', () => {
  it('returns [] for a scaffold-only repo (README + .gitignore only)', () => {
    const repo = mkRepo({ 'README.md': '# hello', '.gitignore': 'node_modules\n' });
    tmpDirs.push(repo);
    expect(buildPlannerRepoSections({ repoPath: repo, previousPlan: null })).toEqual([]);
  });

  it('returns [] for a missing repo path', () => {
    expect(
      buildPlannerRepoSections({
        repoPath: path.join(os.tmpdir(), `nope-${randomUUID()}`),
        previousPlan: null,
      }),
    ).toEqual([]);
  });

  it('emits the file-tree section with the exact fixed prefix for a real-code repo', () => {
    const repo = mkRepo({
      'package.json': '{"name":"app"}',
      'src/index.ts': 'export const x = 1;',
    });
    tmpDirs.push(repo);
    const sections = buildPlannerRepoSections({ repoPath: repo, previousPlan: null });
    expect(sections).toHaveLength(1);
    expect(sections[0]!.startsWith(SECTION_PREFIX)).toBe(true);
    expect(sections[0]!.endsWith('\n```')).toBe(true);
    expect(sections[0]).toContain('src/');
    expect(sections[0]).toContain('index.ts');
    expect(sections[0]).toContain('package.json');
  });

  it('includes architecture.md when present non-empty, capped at 3000 chars with a marker', () => {
    const longArch = 'a'.repeat(5000);
    const repo = mkRepo({
      'src/index.ts': 'export const x = 1;',
      'architecture.md': longArch,
    });
    tmpDirs.push(repo);
    const sections = buildPlannerRepoSections({ repoPath: repo, previousPlan: null });
    expect(sections).toHaveLength(2);
    expect(sections[1]).toBe(`### architecture.md\n\n${'a'.repeat(3000)}\n\n… [truncated]`);
  });

  it('passes short architecture.md content through uncapped and skips a whitespace-only file', () => {
    const repo = mkRepo({
      'src/index.ts': 'export const x = 1;',
      'architecture.md': '# Arch\n\nFastify + Drizzle.\n',
    });
    tmpDirs.push(repo);
    const sections = buildPlannerRepoSections({ repoPath: repo, previousPlan: null });
    expect(sections[1]).toBe('### architecture.md\n\n# Arch\n\nFastify + Drizzle.');

    const blankRepo = mkRepo({
      'src/index.ts': 'export const x = 1;',
      'architecture.md': '   \n\n  ',
    });
    tmpDirs.push(blankRepo);
    const blankSections = buildPlannerRepoSections({ repoPath: blankRepo, previousPlan: null });
    expect(blankSections).toHaveLength(1);
  });

  it('renders the previous-plan block: ISO date header, title fallback to first prompt line, 120-char labels', () => {
    const repo = mkRepo({ 'src/index.ts': 'export const x = 1;' });
    tmpDirs.push(repo);
    const longFirstLine = 'L'.repeat(200);
    const plan = makePlan([
      {
        id: 'a',
        role: 'architect',
        title: 'Set up the data model',
        prompt: 'ignored because title wins',
        deps: [],
        successCriteria: {},
        maxTurns: 10,
      },
      {
        id: 'b',
        role: 'developer',
        prompt: 'implement the API\nsecond line never shows',
        deps: ['a'],
        successCriteria: {},
        maxTurns: 10,
      },
      {
        id: 'c',
        role: 'developer',
        prompt: `${longFirstLine}\nrest`,
        deps: ['a'],
        successCriteria: {},
        maxTurns: 10,
      },
    ]);
    const createdAt = new Date('2026-06-10T12:34:56.000Z');
    const sections = buildPlannerRepoSections({
      repoPath: repo,
      previousPlan: { plan, createdAt },
    });
    expect(sections).toHaveLength(2);
    const block = sections[1]!;
    const lines = block.split('\n');
    expect(lines[0]).toBe('### Previous plan (created 2026-06-10T12:34:56.000Z)');
    expect(lines[1]).toBe('- a [architect] Set up the data model');
    expect(lines[2]).toBe('- b [developer] implement the API');
    expect(lines[3]).toBe(`- c [developer] ${'L'.repeat(120)}`);
    expect(lines).toHaveLength(4);
  });

  it('caps the previous-plan block at 2000 chars by dropping whole trailing lines', () => {
    const repo = mkRepo({ 'src/index.ts': 'export const x = 1;' });
    tmpDirs.push(repo);
    const manyNodes: Plan['nodes'] = Array.from({ length: 100 }, (_, i) => ({
      id: `node-${i}`,
      role: 'developer',
      title: `Task ${i} ${'t'.repeat(50)}`,
      prompt: 'p',
      deps: [],
      successCriteria: {},
      maxTurns: 10,
    }));
    const sections = buildPlannerRepoSections({
      repoPath: repo,
      previousPlan: { plan: makePlan(manyNodes), createdAt: new Date() },
    });
    const block = sections[1]!;
    expect(block.length).toBeLessThanOrEqual(2000);
    // Whole-line truncation: every emitted line is intact.
    for (const line of block.split('\n').slice(1)) {
      expect(line).toMatch(/^- node-\d+ \[developer\] Task \d+ t+$/);
    }
    // It did truncate (100 ~70-char lines >> 2000 chars).
    expect(block.split('\n').length).toBeLessThan(101);
  });
});

describe('loadLatestPreviousPlan', () => {
  async function insertProject(): Promise<string> {
    const id = randomUUID();
    await db
      .insert(projects)
      .values({ id, name: 'prc-proj', goal: 'g', repoPath: '/tmp/prc' })
      .run();
    return id;
  }

  async function insertPlan(
    projectId: string,
    status: 'draft' | 'locked' | 'running' | 'done' | 'failed',
    createdAt: Date,
    dagJson: unknown,
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(plans).values({ id, projectId, dagJson, status, createdAt }).run();
    return id;
  }

  it('returns the newest locked/running/done plan, ignoring drafts and failures', async () => {
    const projectId = await insertProject();
    const oldPlan = makePlan([]);
    const newPlan = makePlan([
      { id: 'only', role: 'architect', prompt: 'p', deps: [], successCriteria: {}, maxTurns: 10 },
    ]);
    await insertPlan(projectId, 'done', new Date(1000), oldPlan);
    await insertPlan(projectId, 'locked', new Date(2000), newPlan);
    // Newer rows that must NOT win: a draft and a failed plan.
    await insertPlan(projectId, 'draft', new Date(3000), makePlan([]));
    await insertPlan(projectId, 'failed', new Date(4000), makePlan([]));

    const result = await loadLatestPreviousPlan(projectId);
    expect(result).not.toBeNull();
    expect(result!.plan.nodes).toHaveLength(1);
    expect(result!.plan.nodes[0]!.id).toBe('only');
    expect(result!.createdAt.getTime()).toBe(2000);
  });

  it('returns null when the project has no executed plan or the dagJson is malformed', async () => {
    const emptyProject = await insertProject();
    expect(await loadLatestPreviousPlan(emptyProject)).toBeNull();

    const draftOnly = await insertProject();
    await insertPlan(draftOnly, 'draft', new Date(1000), makePlan([]));
    expect(await loadLatestPreviousPlan(draftOnly)).toBeNull();

    const corrupt = await insertProject();
    await insertPlan(corrupt, 'locked', new Date(1000), { nope: true });
    expect(await loadLatestPreviousPlan(corrupt)).toBeNull();
  });
});
