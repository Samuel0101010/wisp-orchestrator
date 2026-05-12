---
date: 2026-05-12
tags: [tailwind, shadcn, design-tokens, contrast, light-theme]
files:
  - apps/dashboard-web/src/routes/Agents.tsx
  - apps/dashboard-web/src/components/AgentChat.tsx
related:
  - 2026-05-12-css-var-per-id-fails-for-free-form-types.md
---

# `bg-<token>/<alpha>` + `text-<token>-foreground` renders white-on-white in light theme

## Problem

In the "New agent" dialog, the active model selector ("sonnet") and the
selected Allowed Tools pills ("Read", "Edit", "Bash", "Grep") were
completely unreadable in light theme — the user could see the colored
border but not what was inside. Same anti-pattern in the AgentChat
threads list for the currently-selected thread row. Dark theme
disguised the bug because the white text had a near-black background
behind it.

## Root cause

The active-state classes were:

```tsx
className="border-info bg-info/15 text-info-foreground"
```

The semantic shadcn convention: `text-X-foreground` is the *inverse* of
`bg-X` (intended for white-on-saturated or vice versa). It assumes you
put it on top of *full-opacity* `bg-X`. With `bg-info/15` the background
is 85 % the page background tinted by 15 % of `--info` — i.e. near-white
in light theme. Putting `text-info-foreground` (= pure white in our
token table) on top of that gives white-on-near-white = invisible.

Dark theme worked accidentally: the page background is near-black, so
even after a 15 % blue tint the surface is dark enough that white text
reads fine.

## Solution

For translucent tinted backgrounds, use the *saturated* color itself as
the text color, not its `-foreground` inverse:

```tsx
className="border-info bg-info/15 text-info"
```

`text-info` (`hsl(217 91% 45%)` light, `hsl(217 91% 70%)` dark) reads
cleanly on both light and dark tints because its lightness is far
enough from both surface backgrounds.

Three call sites fixed in v1.6.1:

- `apps/dashboard-web/src/routes/Agents.tsx:440` — model selector
- `apps/dashboard-web/src/routes/Agents.tsx:483` — Allowed Tools pills
- `apps/dashboard-web/src/components/AgentChat.tsx:329` — active thread row

## Verification

Screenshot the dialog in both themes; saturated blue text + border + pale
tint reads clearly in both:

- `audit-artifacts/screenshots/v1.6.1-agent-dialog-light.png`
- `audit-artifacts/screenshots/v1.6.1-agent-dialog-dark.png`

A broader sweep confirmed only those 3 places had the anti-pattern:

```bash
rg 'bg-(info|success|warning|destructive|primary|accent)/(\d+)\s+text-\1-foreground' \
   apps/dashboard-web/src
```

## Lessons

- **Pair tokens by their intended use.** `text-X-foreground` is for
  solid `bg-X`. Translucent tints (`bg-X/<n>`) want `text-X` instead.
- **Dark mode hides this class of bug.** Always screenshot both themes
  during QA, or write an axe-core `color-contrast` rule that runs in
  both. Our axe rule was disabled at v1.6.0 — that's how this slipped.
- **The detection regex above** can sit in CI as a tokens:check
  extension, denying the anti-pattern entirely.
