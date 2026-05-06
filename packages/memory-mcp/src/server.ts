#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { MemoryStore } from './store.js';
import { findTool, tools, type ToolName } from './tools.js';

const DB_PATH = process.env.HARNESS_MEMORY_DB ?? './harness-memory.db';

const store = new MemoryStore(DB_PATH);

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

await server.connect(new StdioServerTransport());
