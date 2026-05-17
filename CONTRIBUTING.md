# Contributing to WISP

Thanks for your interest in WISP. This guide explains how to set up your environment, the local gates we expect green before you open a PR, and the conventions the repo follows.

## Table of contents

- [Code of Conduct](#code-of-conduct)
- [Getting started](#getting-started)
- [Workflow](#workflow)
- [Local gates before push](#local-gates-before-push)
- [Tests](#tests)
- [Internationalization (i18n)](#internationalization-i18n)
- [Accessibility](#accessibility)
- [Documentation](#documentation)
- [Pull requests](#pull-requests)
- [Releases](#releases)

## Code of Conduct

This project follows the [Code of Conduct](./CODE_OF_CONDUCT.md). By participating you agree to uphold it. Report unacceptable behavior to the maintainer listed there.

## Getting started

### Prerequisites

- **Node.js** >= 20.10
- **pnpm** >= 9
- **`claude` CLI** on `PATH` (Claude Code binary; needed for any orchestrator work, optional for purely-UI fixes)
- Acceptance of the project's [Apache-2.0 license](./LICENSE) — every contribution is licensed under Apache-2.0

### Clone and bootstrap

```sh
git clone https://github.com/Samuel0101010/wisp-orchestrator.git
cd wisp-orchestrator
pnpm install --frozen-lockfile
```

### Build shared packages first

Workspace apps depend on the compiled output of `packages/*`. Always build the shared packages before running typecheck/tests so the apps resolve real `.d.ts` files (skipping this step is the historical cause of red local gates — see `docs/solutions/2026-05-16-ci-red-for-5-releases-cached-local-gates.md`):

```sh
pnpm -r --filter "./packages/**" run build
```

### Run the core gates locally

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

When all four are green, you have the same signal CI's `verify` job produces.

## Workflow

### Branch naming

Branch off `main` using one of:

- `feat/<short-slug>` — new feature
- `fix/<short-slug>` — bug fix
- `chore/<short-slug>` — tooling, deps, infra
- `docs/<short-slug>` — documentation only
- `refactor/<short-slug>` — internal restructuring, no behavior change
- `design/<short-slug>` — UI polish, visual changes

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): subject
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `refactor`, `design`, `release`. Scope is the package or surface (`sidebar`, `walker`, `readme`, `release-prep`, ...). Examples from the log:

```
fix(sidebar): render project menu via portal so it doesn't bleed-through
docs(readme): add shields.io badge row under the WISP figure
chore(release-prep): Phase A — scrub local paths and stale markers
```

### Phased shipping

This repo follows a **one phase = one CI-green commit** cadence. Don't bundle unrelated changes; keep each commit focused enough that CI can pass on it alone. If a phase grows beyond ~200 lines of diff, split it.

### PR template

Fill in the PR template (`.github/PULL_REQUEST_TEMPLATE.md`) — it asks for the user-facing summary, the verification you ran, and the rollback plan. Don't leave sections blank.

## Local gates before push

Run these in order from the repo root. They mirror the `verify` job in `.github/workflows/ci.yml`:

```sh
pnpm install --frozen-lockfile
pnpm -r --filter "./packages/**" run build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm --filter dashboard-web tokens:check
pnpm encoding:check
pnpm build
```

If you touched anything under `tests/e2e/` or rendered routes that the smoke covers, also run:

```sh
pnpm exec playwright install chromium   # one-time
pnpm test:e2e
```

## Tests

Where each kind of test belongs:

| Layer | Framework | Location |
| ----- | --------- | -------- |
| Server unit | vitest | `apps/dashboard-server/src/**/*.test.ts` |
| Web unit / component | vitest | `apps/dashboard-web/src/**/*.test.tsx` |
| Orchestrator unit | vitest | `packages/orchestrator/src/__tests__/` |
| Compliance | vitest | `tests/compliance/` |
| End-to-end (UI + API + WS) | Playwright | `tests/e2e/` |

New behavior needs a test at the lowest layer that can prove it. Server route changes get a vitest under `dashboard-server/src/routes/__tests__`; new walker branches get an orchestrator test with a `__mockBin` fixture; user-visible flows get a Playwright case in `tests/e2e/`.

## Internationalization (i18n)

The dashboard ships in English and German. Any user-facing string lives in both:

- `apps/dashboard-web/src/i18n/locales/en/common.json`
- `apps/dashboard-web/src/i18n/locales/de/common.json`

Keep the keys identical between the two files. The Playwright `i18n.spec.ts` test will fail if a translation key is missing on either side.

## Accessibility

The repo has automated axe checks at `tests/e2e/a11y.spec.ts`. They must stay green. When adding interactive UI:

- Every interactive element has a label or `aria-label`.
- Color contrast meets WCAG AA (the design tokens already do — don't override them with hard-coded hex).
- Focus order is logical and visible (test with `Tab` / `Shift+Tab`).

## Documentation

For non-trivial fixes or architectural decisions, drop a short entry in `docs/solutions/YYYY-MM-DD-<slug>.md` capturing the problem, the root cause, and the fix. This is optional but encouraged — future contributors (and future you) will thank you.

User-facing changes also need a `README.md` or `docs/` update if the behavior they describe shifted.

## Pull requests

- Open the PR against `main`.
- CI (`verify` + `e2e`, and `evals` when `RUN_EVALS` is set) must be green.
- At least one maintainer review is required before merge.
- We **squash-merge by default** so each PR becomes one commit on `main` — keep the PR title in Conventional Commits form, since it becomes the squash subject.
- If a reviewer asks for changes, push fixups to the same branch; don't force-push unless rebasing on `main` to resolve a conflict.

## Releases

Releases are cut by maintainers:

1. Bump the version across workspace packages.
2. Tag (`v<major>.<minor>.<patch>`) and push.
3. Create the matching GitHub Release with notes.
4. The `release-badge.yml` workflow updates the README badge automatically.

If you're not a maintainer, just land your PR; the release will pick it up at the next cut.
