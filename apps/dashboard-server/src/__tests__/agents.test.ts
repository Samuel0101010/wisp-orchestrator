import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';

describe('agent CRUD routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    runMigrations();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    sqlite.close();
  });

  it('POST /api/agents creates an agent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'architect-sam',
        model: 'opus',
        systemPrompt: 'You are a senior TypeScript architect with strong opinions.',
        allowedTools: ['Read', 'Grep', 'Glob'],
        description: 'Picks structures',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/[0-9a-f-]{36}/);
    expect(body.name).toBe('architect-sam');
    expect(body.model).toBe('opus');
    expect(Array.isArray(body.allowedTools)).toBe(true);
    expect(body.allowedTools).toContain('Read');
  });

  it('POST /api/agents 400 on invalid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { name: 'x', model: 'gpt-4', systemPrompt: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
  });

  it('GET /api/agents lists agents (newest first)', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'qa-lukas',
        model: 'sonnet',
        systemPrompt: 'You verify integration tests pass before declaring success.',
        allowedTools: ['Read', 'Bash'],
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(2);
    // Names present
    const names = body.map((a: { name: string }) => a.name);
    expect(names).toContain('architect-sam');
    expect(names).toContain('qa-lukas');
  });

  it('PATCH /api/agents/:id updates partial fields', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'patch-me',
        model: 'haiku',
        systemPrompt: 'Initial system prompt that is sufficiently long.',
        allowedTools: [],
      },
    });
    const { id } = created.json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${id}`,
      payload: { name: 'patch-me-renamed', allowedTools: ['Read'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('patch-me-renamed');
    expect(body.allowedTools).toEqual(['Read']);
    expect(body.model).toBe('haiku'); // unchanged
  });

  it('DELETE /api/agents/:id removes the agent (when unreferenced)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'delete-me',
        model: 'haiku',
        systemPrompt: 'Throwaway agent for the delete test.',
        allowedTools: [],
      },
    });
    const { id } = created.json();
    const del = await app.inject({ method: 'DELETE', url: `/api/agents/${id}` });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: `/api/agents/${id}` });
    expect(after.statusCode).toBe(404);
  });

  it('GET /api/agents/:id returns 404 for unknown', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE refuses when agent referenced; force=1 unlinks', async () => {
    // Create an agent
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'referenced-agent',
        model: 'sonnet',
        systemPrompt: 'A referenced agent that lives in a team.',
        allowedTools: [],
      },
    });
    const agentId = created.json().id as string;

    // Create a project + team referencing the agent
    const proj = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'p-ref', goal: 'g-ref', repoPath: '/tmp/r' },
    });
    const projectId = proj.json().id as string;

    const team = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: {
        roles: [
          {
            role: 'architect',
            agentId,
            model: 'sonnet',
            allowedTools: [],
            systemPrompt: 'A referenced agent that lives in a team.',
          },
        ],
      },
    });
    expect(team.statusCode).toBe(200);

    // Delete without force — should refuse
    const refused = await app.inject({ method: 'DELETE', url: `/api/agents/${agentId}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('agent_referenced');

    // Force delete — succeeds and scrubs agentId from the team
    const forced = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}?force=1`,
    });
    expect(forced.statusCode).toBe(204);

    // Team's role should still exist but without agentId
    const teamRead = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/team`,
    });
    expect(teamRead.statusCode).toBe(200);
    const teamBody = teamRead.json();
    expect(teamBody.roles[0].role).toBe('architect');
    expect(teamBody.roles[0].agentId).toBeUndefined();
  });

  it('GET /api/agents/:id/usage lists referencing teams', async () => {
    // Fresh agent + reference
    const a = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'usage-agent',
        model: 'haiku',
        systemPrompt: 'Agent for usage probe test, with a sufficient prompt.',
        allowedTools: [],
      },
    });
    const agentId = a.json().id as string;

    const proj = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'p-usage', goal: 'g-usage', repoPath: '/tmp/u' },
    });
    const projectId = proj.json().id as string;

    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: {
        roles: [
          {
            role: 'developer',
            agentId,
            model: 'haiku',
            allowedTools: [],
            systemPrompt:
              'You implement features cleanly and prefer minimal abstractions over speculative ones.',
          },
        ],
      },
    });
    expect(putRes.statusCode).toBe(200);

    const usage = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/usage` });
    expect(usage.statusCode).toBe(200);
    const body = usage.json();
    expect(body.usage).toHaveLength(1);
    expect(body.usage[0].projectName).toBe('p-usage');
    expect(body.usage[0].role).toBe('developer');
  });
});
