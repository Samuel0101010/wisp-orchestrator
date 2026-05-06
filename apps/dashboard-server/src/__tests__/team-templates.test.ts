import './setup.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../app.js';

const FILLER = 'x'.repeat(80);

function makeRole(role: string, model: 'opus' | 'sonnet' | 'haiku' = 'sonnet') {
  return {
    role,
    model,
    allowedTools: ['Read'],
    systemPrompt: `${role} ${FILLER}`,
  };
}

function makeTemplate(id: string, overrides: Partial<{ name: string; description: string }> = {}) {
  return {
    id,
    name: overrides.name ?? `Template ${id}`,
    description:
      overrides.description ?? `Description for template ${id} that is at least 20 chars long.`,
    team: { roles: [makeRole('architect', 'opus'), makeRole('developer'), makeRole('qa')] },
    suggestedGoals: [`A test goal for template ${id} that is at least 10 chars long.`],
  };
}

describe('GET /api/team-templates', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the four built-in templates sorted by id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/team-templates' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { templates: Array<{ id: string }> };
    const ids = body.templates.map((t) => t.id);
    // Built-ins should be present and sorted.
    for (const id of ['data-pipeline', 'python-backend', 'refactor-squad', 'ts-library']) {
      expect(ids).toContain(id);
    }
    expect(ids).toEqual([...ids].sort());
  });
});

describe('POST /api/team-templates', () => {
  let app: FastifyInstance;
  let templatesDir: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    templatesDir = path.join(process.env.HARNESS_DATA_DIR ?? '.', 'templates');
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    // Clean any user templates created by this test run.
    if (fs.existsSync(templatesDir)) {
      for (const f of fs.readdirSync(templatesDir)) {
        if (f.startsWith('user-test-') || f.startsWith('ts-library')) {
          fs.unlinkSync(path.join(templatesDir, f));
        }
      }
    }
  });

  it('creates a user template file at <dataDir>/templates/<id>.json', async () => {
    const tmpl = makeTemplate('user-test-1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/team-templates',
      payload: tmpl,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { template: { id: string }; path: string };
    expect(body.template.id).toBe('user-test-1');
    expect(fs.existsSync(body.path)).toBe(true);
  });

  it('a saved user template appears in the GET list', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/team-templates',
      payload: makeTemplate('user-test-2'),
    });
    const get = await app.inject({ method: 'GET', url: '/api/team-templates' });
    const body = get.json() as { templates: Array<{ id: string }> };
    expect(body.templates.some((t) => t.id === 'user-test-2')).toBe(true);
  });

  it('a user template with a built-in id overrides the built-in', async () => {
    const customised = {
      ...makeTemplate('ts-library'),
      name: 'My customised TS library',
    };
    await app.inject({
      method: 'POST',
      url: '/api/team-templates',
      payload: customised,
    });
    const get = await app.inject({ method: 'GET', url: '/api/team-templates' });
    const body = get.json() as { templates: Array<{ id: string; name: string }> };
    const tsLib = body.templates.find((t) => t.id === 'ts-library');
    expect(tsLib?.name).toBe('My customised TS library');
  });

  it('returns 400 for an invalid template', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/team-templates',
      payload: { id: '', name: 'x', description: 'x', team: { roles: [] }, suggestedGoals: [] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; issues: unknown[] };
    expect(body.error).toBe('invalid_template');
    expect(body.issues.length).toBeGreaterThan(0);
  });
});
