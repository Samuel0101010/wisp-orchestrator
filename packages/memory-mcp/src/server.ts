#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { MemoryStore } from './store.js';
import { findTool, tools, type ToolName } from './tools.js';

const DB_PATH = process.env.HARNESS_MEMORY_DB;
if (!DB_PATH || DB_PATH.trim().length === 0) {
  process.stderr.write(
    'agent-harness-memory: HARNESS_MEMORY_DB is required (per-run SQLite path). Refusing to start with a default path because that would silently lose memory across runs.\n',
  );
  process.exit(1);
}

let store: MemoryStore;
try {
  store = new MemoryStore(DB_PATH);
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
    const result = tool.handle(store, parsed.data);
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

// Graceful shutdown — ensure the SQLite handle releases the file lock.
function shutdown(): void {
  try {
    store.close();
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

await server.connect(new StdioServerTransport());
