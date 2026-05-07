# Memory MCP

`@agent-harness/memory-mcp` is a stdio MCP server bundled with Agent Harness
that gives every task subprocess in a run access to a small shared key/value
store. Tasks can drop notes for downstream tasks (e.g. the architect writes
`arch.spec`, the developer reads it) without inventing ad-hoc file conventions.

## How it fits

```
RunRuntime
  └─ writeMemoryMcpConfig(runId, dataDir, entrypoint)
       └─ writes  <dataDir>/mcp-configs/<runId>.json
       └─ reserves <dataDir>/memory/<runId>.db

  Walker dispatches a task
    └─ SubprocessPool spawns `claude -p ... --mcp-config <file> --strict-mcp-config`
         └─ claude spawns @agent-harness/memory-mcp's server.js
              └─ MemoryStore opens the SQLite file at HARNESS_MEMORY_DB
              └─ exposes memory.{set,get,list,delete} as MCP tools
```

The MCP server lives in its own subprocess per task; the SQLite WAL allows
multiple readers (the harness uses `journal_mode=WAL`). Within a single run all
tasks read/write the same `<runId>.db`. Different runs get distinct DBs.

## Tool API

### `memory.set({ key: string, value: string }) → { ok: true }`

Upsert. Last write wins. Key is a free-form string; convention is
`<role-or-area>.<topic>` (e.g. `arch.spec`, `dev.notes`).

### `memory.get({ key: string }) → { value: string | null }`

`null` when the key is absent.

### `memory.list({}) → { entries: Array<{ key, size }> }`

Sorted by key ascending. `size` is the UTF-8 character count of the stored
value (useful for guarding against bloat).

### `memory.delete({ key: string }) → { deleted: boolean }`

`true` if a row was removed, `false` if the key was already absent.

## Defaults & permissions

The default team in `apps/dashboard-web/src/data/defaultTeam.ts` allows all
three roles to call:

- `mcp__agent-harness-memory__memory_set`
- `mcp__agent-harness-memory__memory_get`
- `mcp__agent-harness-memory__memory_list`

`mcp__agent-harness-memory__memory_delete` is **intentionally** absent from
defaults — letting agents silently drop shared state by default is too
footgun-y. Add it manually to a role's `allowedTools` if you want it.

**Naming convention.** Claude exposes MCP tools as
`mcp__<server-name>__<tool-name>`, replacing dots in the tool name with
underscores. So our `memory.set` tool (registered in `tools.ts`) becomes
`mcp__agent-harness-memory__memory_set` from the agent's perspective. The
server name `agent-harness-memory` comes from `server.ts`'s
`new Server({ name: 'agent-harness-memory', ... })`.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `HARNESS_MEMORY_DB` | Path to the SQLite file the server opens. Set by the runtime per run. | `./harness-memory.db` |

When invoked outside of the harness (e.g. for debugging), set
`HARNESS_MEMORY_DB` yourself before spawning the binary.

## Where the data lives

```
$HARNESS_DATA_DIR/
├── harness.db                     # main app SQLite (projects, plans, runs, events, ...)
├── memory/
│   ├── <runId>.db                 # one shared kv store per run
│   └── <runId>.db-wal             # WAL files
└── mcp-configs/
    └── <runId>.json               # generated MCP config the subprocesses receive
```

Both directories are created by `writeMemoryMcpConfig` on first use.

## Security note

The memory data **never leaves your local filesystem.** The MCP server is
stdio-only — it has no HTTP/SSE listener, no network code, no Anthropic SDK
imports. The compliance test
(`tests/compliance/no-direct-anthropic.test.ts`) explicitly globs
`packages/memory-mcp/src` to catch any accidental drift.

The values are stored as plain TEXT in SQLite. Don't put secrets in there if
the data directory is shared with other users (it lives under
`HARNESS_DATA_DIR`, which defaults to `os.tmpdir()/agent-harness` in development
and is required to be set explicitly in production).

## Inspecting a run's memory

After a run finishes, you can dump the kv table directly:

```powershell
# PowerShell
node -e "const D=require('better-sqlite3');const db=new D(process.argv[1]); console.log(db.prepare('SELECT key, length(value) AS size, value FROM kv ORDER BY key').all());" "$env:HARNESS_DATA_DIR\memory\<runId>.db"
```

Or via the SQLite CLI if installed:

```sh
sqlite3 "$HARNESS_DATA_DIR/memory/<runId>.db" \
  "SELECT key, length(value), substr(value,1,80) FROM kv ORDER BY key;"
```

## Versioning

The MCP protocol version is pinned by the SDK
(`@modelcontextprotocol/sdk`); the harness installs `^1.0.0` and treats the
SDK's `DEFAULT_NEGOTIATED_PROTOCOL_VERSION` as the wire version. Bumping the
SDK major may require updating the protocol version in
`packages/memory-mcp/src/__tests__/server.test.ts`.

## Out of scope (today)

- No cross-run shared memory. Each run is isolated. (M5+ may revisit.)
- No TTL / expiry on keys.
- No structured value types — values are opaque strings; agents pick a
  serialization (often JSON).
- No server-side auth/ACL. Any task with the MCP tool in `allowedTools` can
  read every key in the run's DB.
