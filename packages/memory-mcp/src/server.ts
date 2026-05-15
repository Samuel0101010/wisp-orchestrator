#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { closeAllStores, resolveStore, type MemoryStore } from './store.js';
import { findTool, tools, type ToolName, type ScopeResolver } from './tools.js';

const DB_PATH = process.env.HARNESS_MEMORY_DB;
if (!DB_PATH || DB_PATH.trim().length === 0) {
  process.stderr.write(
    'agent-harness-memory: HARNESS_MEMORY_DB is required (per-run SQLite path). Refusing to start with a default path because that would silently lose memory across runs.\n',
  );
  process.exit(1);
}

// Project-scoped storage (v1.14, Phase 6) keys off the per-run dataDir +
// projectId. Both are propagated by the dashboard-server via mcp-config.ts.
// Run scope still works exactly as before — HARNESS_PROJECT_ID is only needed
// when an agent passes scope='project' on a tool call.
const DATA_DIR = process.env.HARNESS_DATA_DIR ?? '';
const PROJECT_ID = process.env.HARNESS_PROJECT_ID ?? '';

const resolver: ScopeResolver = (scope): MemoryStore => {
  try {
    return resolveStore({
      scope,
      runDbPath: DB_PATH,
      dataDir: DATA_DIR,
      projectId: PROJECT_ID,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`memory scope='${scope}' unavailable: ${message}`);
  }
};

// Eagerly open the run-scoped store so early failures (bad path, permission
// denied) crash the server before stdio is hooked up — matching v1.13
// behavior where `new MemoryStore(DB_PATH)` ran at startup.
try {
  resolver('run');
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`agent-harness-memory: failed to open SQLite at ${DB_PATH}: ${message}\n`);
  process.exit(1);
}

const server = new Server(
  { name: 'agent-harness-memory', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: (Object.keys(tools) as ToolName[]).map((name) => ({
    name,
    description: tools[name].description,
    inputSchema: zodToJsonSchema(tools[name].inputSchema, {
      target: 'jsonSchema7',
    }) as Record<string, unknown>,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = findTool(req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `unknown tool: ${req.params.name}` }],
    };
  }
  const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
  if (!parsed.success) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `invalid arguments: ${parsed.error.message}` }],
    };
  }
  try {
    const result = tool.handle(resolver, parsed.data);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `tool execution failed: ${message}` }],
    };
  }
});

// Graceful shutdown — ensure SQLite handles release file locks for every
// store the resolver opened (run + project caches).
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    closeAllStores();
  } catch {
    // best-effort
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// On Windows SIGTERM is not reliably delivered to child processes; fall back
// to detecting the parent closing our stdin pipe (the MCP transport). Without
// this the server can outlive the parent claude subprocess, holding the WAL
// file open and preventing checkpoint/truncation.
process.stdin.on('close', shutdown);
process.stdin.on('end', shutdown);
// Last-chance safety net: if the MCP SDK or a bug in a tool handler raises an
// uncaught exception or unhandled rejection, Node.js >=15 terminates the
// process by default — without ever calling our SIGINT/SIGTERM handlers,
// leaving the WAL file open. Route those through shutdown() too so we always
// close the SQLite handle cleanly.
process.on('uncaughtException', shutdown);
process.on('unhandledRejection', shutdown);

await server.connect(new StdioServerTransport());
