---
date: 2026-05-31
tags: [tauri, native-packaging, packager-runner, vitest, test-seam]
files:
  - apps/dashboard-server/src/orchestrator/packager-runner.ts
  - apps/dashboard-server/src/__tests__/packager-runner.test.ts
related:
  - 2026-05-31-wisp-live-ui-testing-gotchas.md
  - 2026-05-29-wisp-dogfood-preview-after-run-working-tree.md
---

# Native packaging never produced an artifact — the Tauri default bundle identifier (v2.0.30)

## Problem

`POST /api/projects/:id/build` always failed with `tauri_build_failed` on any
fresh project — the native-packaging feature could not produce a single
installer. The failure happened in ~5 s, long before any Rust compilation.

This was the one verification deferred as "unforceable" (needs a real Tauri
desktop build). Forcing it end-to-end for real is what surfaced the bug.

## Root cause

`packager-runner.ts` scaffolds `src-tauri/` via `tauri init` when it is missing,
but it passed `--app-name`, `--window-title`, `--frontend-dist`, `--dev-url` —
and **no `--identifier`**. Tauri then defaults the bundle identifier to
`com.tauri.dev`, and `tauri build` hard-rejects that value:

> You must change the bundle identifier in `identifier`. The default value
> `com.tauri.dev` is not allowed as it must be unique across applications.

So the pipeline never reached the compile/bundle step. It shipped because
**every** packager unit test pre-created `src-tauri/` in a temp dir, which makes
`runPackager` skip the `tauri init` branch entirely — the one buggy step had
zero coverage.

## Solution

Derive a unique, valid reverse-DNS identifier and pass it to `tauri init`:

```ts
// packager-runner.ts
export function bundleIdentifier(appName: string | undefined, projectId: string): string {
  const slugify = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let slug = slugify(appName ?? '') || slugify(projectId) || 'app';
  if (!/^[a-z]/.test(slug)) slug = `app-${slug}`;            // segments must start with a letter
  const pid = projectId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8) || '0';
  return `com.wisp.${slug}-${pid}`;                          // unique even for same-named projects
}
// ...in the `tauri init` args: '--identifier', bundleIdentifier(args.appName, args.projectId),
```

A new test drives the previously-untested scaffold path: its mock `tauri init`
*creates* `src-tauri/` (so the flow continues) and the test asserts the captured
init call contains `--identifier` with a value that is **never** `com.tauri.dev`.

## Verification

Real end-to-end build on the Pomodoro dogfood app (Rust 1.95 + `@tauri-apps/cli@2`):
full release compile (tauri 2.11.2 + wry/tao/webview2) in ~2 min, then **both** a
WiX `.msi` and an NSIS `.exe`. `GET /artifact` streamed the `.exe` (1,883,581 B)
with `Content-Disposition`, and the downloaded file's sha256 matched the build
report bit-for-bit. dashboard-server suite 518 → 520; all 9 gates + CI green;
shipped v2.0.30.

## Lessons

- **"Too hard to test / unforceable" is where bugs hide.** The single path with
  no automated coverage (scaffold via `tauri init`) was exactly the broken one.
  Forcing the real build found in minutes what a mock never could — because the
  mocks pre-created `src-tauri/` and skipped the buggy step.
- **Mock seams can hide the bug they're meant to cover.** When a test seam lets
  you skip a setup step (here: pre-making `src-tauri/`), add at least one test
  that exercises the *real* branch (the mock `tauri init` that actually creates
  the dir), or the un-mocked step stays unverified.
- **Tauri's default identifier `com.tauri.dev` is a build-blocker, not a
  warning.** Any programmatic `tauri init` must pass an explicit, unique
  `--identifier`.
- Setting up the build also needs `@tauri-apps/cli` installed *in the app repo*
  (`pnpm exec tauri` resolves locally) — the packager probes it but does not
  install it.
