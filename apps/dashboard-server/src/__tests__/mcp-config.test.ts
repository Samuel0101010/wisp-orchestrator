import './setup.js';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { plans, projects } from '@wisp/schemas';
import type { Walker, WalkerDeps } from '@wisp/orchestrator';
import { MEMORY_PROTOCOL_SECTION, writeMemoryMcpConfig } from '../orchestrator/mcp-config.js';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { RunRuntime } from '../orchestrator/runtime.js';

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

describe('writeMemoryMcpConfig', () => {
  it('writes a JSON file with mcpServers.wisp-memory pointing at the entrypoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    try {
      const result = writeMemoryMcpConfig({
        runId: 'run-abc',
        dataDir: dir,
        memoryMcpEntrypoint: '/path/to/server.js',
      });
      expect(result.path).toBe(join(dir, 'mcp-configs', 'run-abc.json'));
      expect(result.dbPath).toBe(join(dir, 'memory', 'run-abc.db'));
      expect(existsSync(result.path)).toBe(true);
      const cfg = JSON.parse(await readFile(result.path, 'utf8'));
      expect(cfg.mcpServers['wisp-memory']).toBeDefined();
      expect(cfg.mcpServers['wisp-memory'].command).toBe(process.execPath);
      expect(cfg.mcpServers['wisp-memory'].args).toEqual(['/path/to/server.js']);
      expect(cfg.mcpServers['wisp-memory'].env.WISP_MEMORY_DB).toBe(result.dbPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates mcp-configs and memory subdirectories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    try {
      writeMemoryMcpConfig({
        runId: 'run-xyz',
        dataDir: dir,
        memoryMcpEntrypoint: '/x/server.js',
      });
      expect(existsSync(join(dir, 'mcp-configs'))).toBe(true);
      expect(existsSync(join(dir, 'memory'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exports WISP_DATA_DIR + HARNESS_PROJECT_ID when projectId is supplied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    try {
      const result = writeMemoryMcpConfig({
        runId: 'run-with-proj',
        dataDir: dir,
        memoryMcpEntrypoint: '/path/to/server.js',
        projectId: 'proj-1',
      });
      const cfg = JSON.parse(await readFile(result.path, 'utf8'));
      const env = cfg.mcpServers['wisp-memory'].env;
      expect(env.WISP_MEMORY_DB).toBe(result.dbPath);
      expect(env.HARNESS_PROJECT_ID).toBe('proj-1');
      expect(env.WISP_DATA_DIR).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('omits HARNESS_PROJECT_ID + WISP_DATA_DIR when projectId is not supplied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    try {
      const result = writeMemoryMcpConfig({
        runId: 'run-no-proj',
        dataDir: dir,
        memoryMcpEntrypoint: '/path/to/server.js',
      });
      const cfg = JSON.parse(await readFile(result.path, 'utf8'));
      const env = cfg.mcpServers['wisp-memory'].env;
      expect(env.HARNESS_PROJECT_ID).toBeUndefined();
      expect(env.WISP_DATA_DIR).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('MEMORY_PROTOCOL_SECTION', () => {
  it('stays within the 450-char prompt budget and teaches only tools the MCP server exposes', () => {
    expect(MEMORY_PROTOCOL_SECTION.length).toBeLessThanOrEqual(450);
    expect(MEMORY_PROTOCOL_SECTION).toContain('## Shared memory');
    // The wisp-memory MCP surfaces memory.set/get/list/delete (see
    // packages/memory-mcp/src/tools.ts) — there is NO memory_search tool.
    expect(MEMORY_PROTOCOL_SECTION).toContain('memory.list');
    expect(MEMORY_PROTOCOL_SECTION).toContain('memory.get');
    expect(MEMORY_PROTOCOL_SECTION).toContain('memory.set');
    expect(MEMORY_PROTOCOL_SECTION).not.toContain('memory_search');
    expect(MEMORY_PROTOCOL_SECTION).toContain('decisions/');
    expect(MEMORY_PROTOCOL_SECTION).toContain('patterns/');
  });

  it('reaches WalkerDeps.briefContext even for a project with NO brief', async () => {
    const projectId = randomUUID();
    await db
      .insert(projects)
      .values({
        id: projectId,
        name: 'p',
        goal: 'g',
        repoPath: '/tmp/repo',
        createdAt: new Date(),
      })
      .run();
    const planId = randomUUID();
    const plan = {
      goal: 'g',
      team: {
        roles: [
          { role: 'developer', model: 'sonnet', allowedTools: [], systemPrompt: 'd'.repeat(60) },
        ],
      },
      nodes: [
        { id: 'n1', role: 'developer', prompt: 'p', deps: [], successCriteria: {}, maxTurns: 5 },
      ],
      edges: [],
    };
    await db
      .insert(plans)
      .values({ id: planId, projectId, dagJson: plan as unknown, status: 'locked' })
      .run();

    const captured: { deps: WalkerDeps | null } = { deps: null };
    const runtime = new RunRuntime({
      db,
      ws: { publishToRun: () => {} },
      snapshotIntervalMs: 60_000,
      buildWalker: ({ walkerDeps }) => {
        captured.deps = walkerDeps;
        const walker: Partial<Walker> = {
          async start() {
            return new Promise(() => undefined); // never settles — keeps the run live
          },
          async pauseForShutdown() {},
          async cancel() {},
        };
        return walker as Walker;
      },
    });

    const start = await runtime.startRun({ planId });
    expect(start.ok).toBe(true);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    expect(captured.deps).not.toBeNull();
    expect(captured.deps!.briefContext).toBeDefined();
    expect(captured.deps!.briefContext).toContain(MEMORY_PROTOCOL_SECTION);
  });
});
