# WISP — promo video (Remotion)

A modern, ~53-second promo for **wisp-orchestrator**, built with
[Remotion](https://remotion.dev). Standalone project — it lives **outside** the
pnpm workspace and has its own `package.json` / `node_modules`, so it never
touches the repo's 8 CI gates (it is also listed in the repo `.prettierignore`
and `eslint.config.js` ignores).

## Output

Two compositions render from the same scene code:

| Composition id | Size | Use |
|---|---|---|
| `promo-landscape` | 1920×1080 | README, GitHub, YouTube, landing page |
| `promo-vertical` | 1080×1920 | Instagram / TikTok / Shorts |

53s · 30fps · silent (kinetic typography carries the message; a music slot is
wired and ready — see below).

## Develop / preview

```bash
npm install
npm run dev        # opens Remotion Studio — scrub, tweak, hot-reload
```

## Render

```bash
npm run render           # → out/wisp-promo-landscape.mp4
npm run render:vertical  # → out/wisp-promo-vertical.mp4
npm run render:all       # both
```

Single still for QA: `npx remotion still promo-landscape out/frame.png --frame=450`

## Storyboard (7 scenes)

1. **Hook** — wordmark + "Orchestrate your AI agent crew."
2. **Problem** — one isolated agent; "One agent. One thread. One thing at a time."
3. **Crew** — assemble a team of real specialists (portrait roster).
4. **Plan graph** — the goal becomes an animated dependency DAG.
5. **Live run** — the crew runs in parallel; status pills flip queued→running→passed.
6. **Montage** — Mission Control · Chat · Skills · Insights · Goal Planner · Prompt Bundles.
7. **Install / CTA** — the three install commands typed live + end card.

Scene lengths live in `src/scenes.config.ts` (single source of truth for both
the timeline and the composition duration).

## Music slot

Silent by default. To score it: drop a track into `public/audio/` and set
`MUSIC_SRC` in `src/scenes.config.ts`, e.g. `export const MUSIC_SRC = 'audio/track.mp3';`.
The whole video is 53s, so trim/loop the track to match.

## Assets

- `public/screenshots/*.png` — the live dashboard in **dark** theme, captured
  with `scripts/capture-dark-screens.mjs` (needs the dashboard running on
  `:4400` with `WISP_SERVE_WEB=1 WISP_MOCK_CLI=1`). Re-run after a UI change.
- `public/avatars/seed-*.jpg`, `public/wisp-wordmark.png`, `public/wisp-mascot.png`
  — copied from `apps/dashboard-web/public/` (the real brand assets).

## Platform note

Remotion 4 ships its bundler (rspack) and compositor as per-OS native binaries.
npm sometimes skips the optional platform package; this project pins the Windows
ones (`@rspack/binding-win32-x64-msvc`, `@remotion/compositor-win32-x64-msvc`).
On macOS/Linux, install the matching binaries instead, e.g.
`@remotion/compositor-mac-arm64` / `@remotion/compositor-linux-x64-gnu`.
