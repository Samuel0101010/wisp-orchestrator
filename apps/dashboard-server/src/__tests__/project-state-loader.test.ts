import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getLatestProjectState,
  parseProjectStateMarkdown,
  persistProjectState,
} from '../orchestrator/project-state-loader.js';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';

beforeAll(() => {
  runMigrations();
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO projects
         (id, name, goal, repo_path, created_at, auto_merge_on_success, self_healing_enabled, max_chain_iterations, default_autopilot_mode, runtime_verify_enabled, package_target)
       VALUES ('p-state', 'state', 'g', 'C:/tmp/state', ?, 1, 0, 3, 0, 1, 'web')`,
    )
    .run(Date.now());
});

afterAll(() => {
  sqlite.close();
});

describe('parseProjectStateMarkdown', () => {
  it('returns empty arrays for an empty input', () => {
    const r = parseProjectStateMarkdown('');
    expect(r).toEqual({
      completedFeatures: [],
      openTodos: [],
      knownIssues: [],
      architectureSnapshot: null,
    });
  });

  it('parses the canonical four-section structure', () => {
    const md = [
      '# Project State',
      '',
      '## Implemented features',
      '- Goal-tracking CRUD',
      '- Auth via OAuth',
      '',
      '## Open todos',
      '- Add CSV export',
      '',
      '## Known issues',
      '- Slow render on >1000 rows',
      '',
      '## Architecture snapshot',
      '```json',
      '{"topLevel": ["src/", "tests/"]}',
      '```',
    ].join('\n');
    const r = parseProjectStateMarkdown(md);
    expect(r.completedFeatures).toEqual(['Goal-tracking CRUD', 'Auth via OAuth']);
    expect(r.openTodos).toEqual(['Add CSV export']);
    expect(r.knownIssues).toEqual(['Slow render on >1000 rows']);
    expect(r.architectureSnapshot).toEqual({ topLevel: ['src/', 'tests/'] });
  });

  it('is tolerant of mixed bullet markers and extra prose between sections', () => {
    const md = [
      '## Completed features',
      'Some preamble',
      '* one',
      '- two',
      '',
      'More prose',
      '## Issues',
      '- a bug',
    ].join('\n');
    const r = parseProjectStateMarkdown(md);
    expect(r.completedFeatures).toEqual(['one', 'two']);
    expect(r.knownIssues).toEqual(['a bug']);
  });

  it('handles missing architecture fence gracefully', () => {
    const md = [
      '## Implemented features',
      '- thing',
      '',
      '## Architecture snapshot',
      'no fence here, just prose',
    ].join('\n');
    const r = parseProjectStateMarkdown(md);
    expect(r.completedFeatures).toEqual(['thing']);
    expect(r.architectureSnapshot).toBeNull();
  });

  it('returns null architectureSnapshot on malformed JSON in fence', () => {
    const md = ['## Architecture snapshot', '```', '{ not: json,', '```'].join('\n');
    const r = parseProjectStateMarkdown(md);
    expect(r.architectureSnapshot).toBeNull();
  });

  it('strips a leading `json` info-string line inside the fence', () => {
    const md = ['## Architecture snapshot', '```', 'json', '{"k":"v"}', '```'].join('\n');
    const r = parseProjectStateMarkdown(md);
    expect(r.architectureSnapshot).toEqual({ k: 'v' });
  });
});

describe('persistProjectState + getLatestProjectState', () => {
  it('round-trips a state row', async () => {
    const id = await persistProjectState({
      db,
      projectId: 'p-state',
      runId: null,
      stateMdPath: 'docs/project-state.md',
      parsed: {
        completedFeatures: ['login'],
        openTodos: ['logout'],
        knownIssues: [],
        architectureSnapshot: { topLevel: ['src/'] },
      },
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const latest = await getLatestProjectState(db, 'p-state');
    expect(latest).not.toBeNull();
    expect(latest!.completedFeatures).toEqual(['login']);
    expect(latest!.openTodos).toEqual(['logout']);
    expect(latest!.architectureSnapshot).toEqual({ topLevel: ['src/'] });
  });

  it('getLatestProjectState returns the most recent row when multiple exist', async () => {
    await new Promise((r) => setTimeout(r, 5)); // ensure createdAt strictly later
    await persistProjectState({
      db,
      projectId: 'p-state',
      runId: null,
      stateMdPath: null,
      parsed: {
        completedFeatures: ['login', 'logout'],
        openTodos: [],
        knownIssues: ['session leak'],
        architectureSnapshot: null,
      },
    });
    const latest = await getLatestProjectState(db, 'p-state');
    expect(latest!.knownIssues).toEqual(['session leak']);
    expect(latest!.completedFeatures).toContain('logout');
  });

  it('getLatestProjectState returns null when no rows exist', async () => {
    const r = await getLatestProjectState(db, 'p-no-such-project-id');
    expect(r).toBeNull();
  });
});
