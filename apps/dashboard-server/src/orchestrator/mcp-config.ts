import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * "## Shared memory" protocol paragraph appended to every agent's brief
 * context (see runtime.makeWalkerDeps). Teaches the crew the read-before-
 * decide / write-after-decide convention over the wisp-memory MCP server so
 * decisions propagate across tasks and runs. Keep it <= 450 chars total —
 * it rides along in EVERY task prompt.
 */
export const MEMORY_PROTOCOL_SECTION = [
  '## Shared memory',
  'At task start, call memory.list (scope project), then memory.get the decisions/* and patterns/* keys it returns to pick up choices earlier agents already made. After any non-obvious choice (library, schema, naming, architecture), record it with memory.set (scope project) under a key like decisions/<topic> or patterns/<topic> so later agents follow it instead of re-deciding.',
].join('\n');

export interface WriteMemoryMcpConfigArgs {
  runId: string;
  dataDir: string;
  memoryMcpEntrypoint: string;
  /**
   * v1.14 — when present, the per-task subprocess can resolve a project-
   * scoped memory DB at `<dataDir>/memory/project-<projectId>.db`. Required
   * for agents to call `memory.{set,get,list,delete}` with scope='project'.
   * When omitted the project-scope tools will surface an error at call time,
   * but run-scope continues to work.
   */
  projectId?: string;
}

export interface WriteMemoryMcpConfigResult {
  /** Absolute path to the generated mcp-config JSON. */
  path: string;
  /** Absolute path to the per-run SQLite file the server will open. */
  dbPath: string;
}

/**
 * Writes a per-run MCP config JSON pointing at the wisp-memory
 * stdio server, with a per-run SQLite DB path. The runtime calls this before
 * walker.start; the file is consumed by every claude -p subprocess via
 * --mcp-config (passed by the SubprocessPool's defaultMcpConfigPath).
 *
 * Both paths are returned so callers can inspect the DB after a run.
 */
const RUN_ID_RE = /^[a-zA-Z0-9_-]+$/;
const PROJECT_ID_RE = /^[a-zA-Z0-9_-]+$/;

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
  const env: Record<string, string> = {
    WISP_MEMORY_DB: dbPath,
  };
  if (args.projectId) {
    if (!PROJECT_ID_RE.test(args.projectId)) {
      throw new Error(`writeMemoryMcpConfig: invalid projectId ${JSON.stringify(args.projectId)}`);
    }
    // Memory-mcp resolves the per-project DB from these two env vars; pass
    // them in so scope='project' works in the per-task subprocess.
    env.WISP_DATA_DIR = dataDirAbs;
    env.HARNESS_PROJECT_ID = args.projectId;
  }
  const cfg = {
    mcpServers: {
      'wisp-memory': {
        command: process.execPath,
        args: [args.memoryMcpEntrypoint],
        env,
      },
    },
  };
  const cfgPath = path.join(cfgDir, `${args.runId}.json`);
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  return { path: cfgPath, dbPath };
}
