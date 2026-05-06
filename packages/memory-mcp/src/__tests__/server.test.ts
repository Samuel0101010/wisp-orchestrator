import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_BIN = resolve(here, '..', '..', 'dist', 'server.js');

interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcChild {
  child: ChildProcessWithoutNullStreams;
  send: (method: string, params?: unknown) => Promise<RpcResponse>;
  close: () => Promise<void>;
}

function startServer(dbPath: string): JsonRpcChild {
  const child = spawn(process.execPath, [SERVER_BIN], {
    env: { ...process.env, HARNESS_MEMORY_DB: dbPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  const pending = new Map<number, (r: RpcResponse) => void>();
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as RpcResponse;
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        // ignore non-JSON
      }
    }
  });

  // Ignore stderr unless debugging.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => {
    /* intentionally swallowed */
  });

  function send(method: string, params: unknown = {}): Promise<RpcResponse> {
    const id = nextId++;
    const payload = { jsonrpc: '2.0' as const, id, method, params };
    return new Promise((resolveFn, rejectFn) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectFn(new Error(`timeout waiting for response to ${method}`));
      }, 5_000);
      pending.set(id, (r) => {
        clearTimeout(timer);
        resolveFn(r);
      });
      child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  async function close(): Promise<void> {
    if (!child.killed) {
      child.stdin.end();
      await new Promise<void>((resolveFn) => {
        const t = setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch {
            /* ignore */
          }
          resolveFn();
        }, 500);
        child.once('exit', () => {
          clearTimeout(t);
          resolveFn();
        });
      });
    }
  }

  return { child, send, close };
}

describe('memory-mcp stdio server (end-to-end)', () => {
  let tmpDir: string;
  let dbPath: string;
  let rpc: JsonRpcChild;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mem-mcp-server-'));
    dbPath = join(tmpDir, 'mem.db');
    rpc = startServer(dbPath);
    // MCP requires an initialize handshake before any other request.
    await rpc.send('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.1' },
    });
  });

  afterAll(async () => {
    await rpc.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('lists exactly the four memory.* tools with input schemas', async () => {
    const res = await rpc.send('tools/list');
    const result = res.result as { tools: Array<{ name: string; inputSchema: unknown }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['memory.delete', 'memory.get', 'memory.list', 'memory.set']);
    // Every tool has a JSON Schema input — verify by spot-checking memory.set.
    const setTool = result.tools.find((t) => t.name === 'memory.set');
    expect(setTool).toBeDefined();
    expect(typeof setTool!.inputSchema).toBe('object');
  });

  it('round-trips memory.set then memory.get', async () => {
    const setRes = await rpc.send('tools/call', {
      name: 'memory.set',
      arguments: { key: 'arch.spec', value: 'use ESM imports' },
    });
    const setResult = setRes.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(JSON.parse(setResult.content[0]!.text)).toEqual({ ok: true });

    const getRes = await rpc.send('tools/call', {
      name: 'memory.get',
      arguments: { key: 'arch.spec' },
    });
    const getResult = getRes.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(JSON.parse(getResult.content[0]!.text)).toEqual({ value: 'use ESM imports' });
  });

  it('memory.list and memory.delete work over RPC', async () => {
    await rpc.send('tools/call', {
      name: 'memory.set',
      arguments: { key: 'b.key', value: 'second' },
    });
    const listRes = await rpc.send('tools/call', { name: 'memory.list', arguments: {} });
    const listResult = listRes.result as { content: Array<{ type: string; text: string }> };
    const listed = JSON.parse(listResult.content[0]!.text) as {
      entries: Array<{ key: string; size: number }>;
    };
    expect(listed.entries.map((e) => e.key)).toContain('arch.spec');
    expect(listed.entries.map((e) => e.key)).toContain('b.key');

    const delRes = await rpc.send('tools/call', {
      name: 'memory.delete',
      arguments: { key: 'b.key' },
    });
    const delResult = delRes.result as { content: Array<{ type: string; text: string }> };
    expect(JSON.parse(delResult.content[0]!.text)).toEqual({ deleted: true });
  });

  it('returns isError for an unknown tool', async () => {
    const res = await rpc.send('tools/call', {
      name: 'memory.purge',
      arguments: {},
    });
    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unknown tool');
  });

  it('returns isError for invalid arguments', async () => {
    const res = await rpc.send('tools/call', {
      name: 'memory.set',
      arguments: { key: '' }, // empty key, no value
    });
    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('invalid arguments');
  });
});
