import './setup.js';
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { writeMemoryMcpConfig } from '../orchestrator/mcp-config.js';

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
