import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface WriteMemoryMcpConfigArgs {
  runId: string;
  dataDir: string;
  memoryMcpEntrypoint: string;
}

export interface WriteMemoryMcpConfigResult {
  /** Absolute path to the generated mcp-config JSON. */
  path: string;
  /** Absolute path to the per-run SQLite file the server will open. */
  dbPath: string;
}

/**
 * Writes a per-run MCP config JSON pointing at the agent-harness-memory
 * stdio server, with a per-run SQLite DB path. The runtime calls this before
 * walker.start; the file is consumed by every claude -p subprocess via
 * --mcp-config (passed by the SubprocessPool's defaultMcpConfigPath).
 *
 * Both paths are returned so callers can inspect the DB after a run.
 */
const RUN_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function writeMemoryMcpConfig(args: WriteMemoryMcpConfigArgs): WriteMemoryMcpConfigResult {
  // Defense in depth: runIds are randomUUID() in production. Reject anything
  // that could escape cfgDir/memDir via path separators or '..'.
  if (!RUN_ID_RE.test(args.runId)) {
    throw new Error(`writeMemoryMcpConfig: invalid runId ${JSON.stringify(args.runId)}`);
  }
  // Resolve to absolute up front: the path is passed verbatim to `claude -p
  // --mcp-config <path>` which runs from each task's worktree cwd, so a
  // relative path would be looked up under the wrong root.
  const dataDirAbs = path.resolve(args.dataDir);
  const cfgDir = path.join(dataDirAbs, 'mcp-configs');
  mkdirSync(cfgDir, { recursive: true });
  const memDir = path.join(dataDirAbs, 'memory');
  mkdirSync(memDir, { recursive: true });
  const dbPath = path.join(memDir, `${args.runId}.db`);
  const cfg = {
    mcpServers: {
      'agent-harness-memory': {
        command: process.execPath,
        args: [args.memoryMcpEntrypoint],
        env: {
          HARNESS_MEMORY_DB: dbPath,
        },
      },
    },
  };
  const cfgPath = path.join(cfgDir, `${args.runId}.json`);
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  return { path: cfgPath, dbPath };
}
