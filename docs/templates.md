# Team templates

A template is a **named, reusable team configuration** plus a small bundle of
suggested goals. The picker lives in the New Project dialog — choosing a
template seeds the team and pre-fills the goal field.

## Built-in templates

Four templates ship with the harness, defined as JSON files at
[`apps/dashboard-server/src/templates/`](../apps/dashboard-server/src/templates):

| id              | Roles                                      | Verify-friendly for                                    |
| --------------- | ------------------------------------------ | ------------------------------------------------------ |
| `ts-library`    | architect / core-dev / test-dev / qa       | Small TS libraries (build/test/lint gates)             |
| `python-backend`| architect / api-dev / test-dev / qa        | Python services (pytest, Pip-based verify)             |
| `refactor-squad`| architect / refactor-dev / qa              | Safe code transforms with high test coverage           |
| `data-pipeline` | architect / pipeline-dev / validator / qa  | CSV/JSON pipelines with backpressure tests             |

Each template is validated against `templateSchema`
([`apps/dashboard-server/src/templates/index.ts`](../apps/dashboard-server/src/templates/index.ts))
at server boot — CI fails if any drifts.

## Schema

```ts
{
  id: string;            // kebab-case, unique within builtins+user
  name: string;          // human-readable
  description: string;   // shown in picker
  team: Team;            // { roles: AgentSpec[] } per packages/schemas
  suggestedGoals: string[];
}
```

`AgentSpec.systemPrompt` must be 40–4000 chars; `AgentSpec.role` matches
`^[a-z][a-z0-9-]*$`. Templates carry the same allowedTools strings the
TeamBuilder uses, including the fully-qualified MCP tools
(`mcp__agent-harness-memory__memory_set`, …).

## API

```
GET  /api/team-templates         → { templates: Template[] }   (built-ins + user)
POST /api/team-templates         → { id }                      (user-saved)
```

To remove a user-saved template, delete the file directly:
`<WISP_DATA_DIR>/templates/<id>.json`. There is no DELETE endpoint
today.

The handler is in
[`apps/dashboard-server/src/routes/team-templates.ts`](../apps/dashboard-server/src/routes/team-templates.ts).
Built-ins cannot be modified or deleted via the API — only user-saved templates
under `<WISP_DATA_DIR>/templates/<id>.json` are mutable. The on-disk format
matches the schema above; the loader is at
[`apps/dashboard-server/src/templates/disk-store.ts`](../apps/dashboard-server/src/templates/disk-store.ts).

## Saving the current team as a template

`POST /api/team-templates` with the project's current team payload. The
TeamBuilder UI surfaces a "Save as Template" button that fires this; user
templates persist across server restarts because they live as JSON files,
not in SQLite.

## Picker flow (frontend)

1. New Project dialog calls `useTemplates()` → fetches `/api/team-templates`.
2. User clicks a template card; the dialog seeds the project goal from
   `suggestedGoals[0]` and the team from `template.team`.
3. On Create, the dialog POSTs `/api/projects` then PUTs `/api/projects/:id/team`
   with the seeded payload. `none` skips the team-PUT and lets the user
   configure manually.

## Authoring a new built-in

1. Add a JSON file to `apps/dashboard-server/src/templates/`.
2. Import + register it in `index.ts`.
3. Run `pnpm --filter @wisp/dashboard-server test` to verify the
   schema parser accepts it.
4. The build script (`scripts/copy-templates.mjs`) copies the JSON to
   `dist/templates/` automatically.
