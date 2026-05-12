# Agent Harness v1.6.0 — QA Screenshot Review (Test Agent D)

Captured 48 full-page screenshots: 12 routes x 2 themes (dark/light) x 2 langs (en/de) at 1440x900.

Backend: http://localhost:4400 v1.6.0 healthy. Frontend: http://localhost:5173.

Script: `audit-artifacts/scripts/screenshot-all.mjs` (standalone, uses Playwright from `tests/e2e/node_modules/@playwright/test`).
Manifest: `audit-artifacts/qa-screenshot-manifest.json`.

## All screenshot files

### Static routes (8 routes x 4 variants = 32)

- `audit-artifacts/screenshots/v1.6.0-qa-root-{dark,light}-{en,de}.png`
- `audit-artifacts/screenshots/v1.6.0-qa-chat-{dark,light}-{en,de}.png`
- `audit-artifacts/screenshots/v1.6.0-qa-agents-{dark,light}-{en,de}.png`
- `audit-artifacts/screenshots/v1.6.0-qa-skills-{dark,light}-{en,de}.png`
- `audit-artifacts/screenshots/v1.6.0-qa-workers-{dark,light}-{en,de}.png`
- `audit-artifacts/screenshots/v1.6.0-qa-insights-{dark,light}-{en,de}.png`
- `audit-artifacts/screenshots/v1.6.0-qa-goap-{dark,light}-{en,de}.png`
- `audit-artifacts/screenshots/v1.6.0-qa-prompt-bundles-{dark,light}-{en,de}.png`

### Project-scoped (4 routes x 4 variants = 16)

Project used: `csv-to-json-cli` (id `28577a95-6c48-420f-814a-9e1fdb4d36b0`).
Run used: `008bd6f3-88aa-4fb3-a24d-5f50976786fc` (status failed).

- `audit-artifacts/screenshots/v1.6.0-qa-project-csv-to-json-cli-{dark,light}-{en,de}.png`
- `audit-artifacts/screenshots/v1.6.0-qa-project-csv-to-json-cli-teams-{dark,light}-{en,de}.png`
- `audit-artifacts/screenshots/v1.6.0-qa-project-csv-to-json-cli-plan-{dark,light}-{en,de}.png`
- `audit-artifacts/screenshots/v1.6.0-qa-project-csv-to-json-cli-run-008bd6f3-{dark,light}-{en,de}.png`

## Per-route review

### / (Mission Control)
Layout solid. Mojibake on multiple labels: `Mission Control Â· today`, `manage â†—`, `THREADS Â· 1`, `1 participant Â·`. Cause: UTF-8 middle-dot/arrow chars decoded as Latin-1. Affects all 4 variants. Light theme contrast OK. DE translations applied.

### /chat
Chat layout clean in all 4. Same mojibake: `1 participant Â· 2 actions`. Translations applied (Konversationen, Personen, Komprimieren). Empty-state message shown for new thread.

### /agents
Grid renders perfectly. Issue: `23h ago` stays English in DE locale (should be `vor 23 Std`). Seed-agent description strings are English in DE — acceptable (data, not chrome). Light theme: tag chips legible.

### /skills
Fully translated chrome in DE (Alle/Eingebaut/Projekt, "keine Tools", "Skills neu laden"). Skill descriptions are manifest text (English) — expected. No layout issues. Best-translated page.

### /workers
Page heading "Workers" not localized in DE. Description/columns/buttons/status badges translated correctly. Otherwise clean table.

### /insights
Heading "Insights" not localized in DE. Column header "OUTCOME" stays English while neighbors (ZEIT/ZIEL/TOKENS) are translated — inconsistent. `failure` cell content is data. Run-summary blob is plain text — acceptable.

### /goap
Heading and labels translated (GOAP-Planer, START-ZUSTAND, etc). Button `Load example` stays English in DE locale. Otherwise clean.

### /prompt-bundles
Fully translated, clean, both themes legible. No issues.

### /projects/:id (csv-to-json-cli)
Cards well translated (Ziel, Repo-Pfad, Team, Plan, Run-Historie). Run status column shows raw `failure` data — acceptable. Badge `FEHLGESCHLAGEN` translated. Good.

### /projects/:id/teams (Team Builder)
Truncated role headings: `backe...` and `qa-en...` even with abundant space — text-overflow rule too aggressive. Helper `Balanced. Default for development work.` stays EN in DE. Buttons `Pick tools` and select options `sonnet — standard` not localized in DE. Layout otherwise fine.

### /projects/:id/plan (Plan Editor)
Headings and chrome translated. Bug: role badges (`BACKEND-DEV`, `QA-ENGINEER`) on plan nodes have low/no contrast in LIGHT theme — barely visible. Dark theme shows them clearly. Affects light-en and light-de.

### /projects/:id/run/:runId (Run View)
Top toolbar very dense (Pause Run | Time bar | Turns bar | tokens) — readable at 1440 but tight. Cancel button in LIGHT theme has light pink background with light text — low contrast (visible in light-en and light-de). Run pipeline kanban columns translated (AUSSTEHEND/LÄUFT/VERIFIZIERE/FERTIG/FEHLGESCHLAGEN). Good DE coverage; "Live tail" → "Live-Stream" translated.

## Top issues (ranked)

1. **P1 — Mojibake on dashboard chrome**: `Â·` and `â†—` glyphs on Mission Control, Chat, Run header. Strongly suggests a response or template re-encoded UTF-8 as Latin-1 somewhere in the rendering chain (or hard-coded HTML entities mis-decoded). Visible in every variant of `/` and `/chat`, and in chat-thread headers across the app.
2. **P1 — Plan Editor role badges invisible in light theme**: `BACKEND-DEV` / `QA-ENGINEER` chips next to plan nodes have near-white-on-white in light mode. Critical for usability of the planner.
3. **P2 — Cancel button low contrast in light theme on Run View**: light pink fill + light text. Looks disabled when it isn't.
4. **P2 — Team Builder role-card headings truncated** (`backe...`, `qa-en...`) despite available width.
5. **P2 — i18n gaps**: page headings `Workers`, `Insights` and Insights' `OUTCOME` column still English in DE. `Load example`, `Pick tools`, `sonnet — standard`, "Balanced. Default for development work." remain English in DE.
6. **P3 — Relative-time strings not localized**: `23h ago`, `1m 2s`, `5s` stay English in DE.
7. **P3 — Run View toolbar density**: tight at 1440; would wrap awkwardly at narrower widths.

Sidebar, project list, theme toggle, lang toggle, search shortcut chip render correctly in every variant. No broken layouts beyond the items above.
