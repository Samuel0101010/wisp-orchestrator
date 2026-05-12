---
date: 2026-05-12
tags: [i18n, subagents, utf-8, file-encoding, qa-visual]
files:
  - apps/dashboard-web/src/components/AgentChat.tsx
  - apps/dashboard-web/src/routes/Chat.tsx
related: []
---

# Subagent edits double-encoded UTF-8 multi-byte characters into source files

## Problem

After a multi-task subagent pass that touched many TSX files (v1.6.0 i18n
migration), the rendered dashboard showed mojibake like `Â·` instead of
`·` and `â†→` instead of `→` on Mission Control, Chat headers, Run View,
etc. ESLint, Prettier, tsc, and the entire e2e suite all passed cleanly —
the bug was invisible to text-only checks because the broken bytes are
*valid UTF-8*, just wrong characters. Caught only by visual QA
screenshots in the post-release sweep.

## Root cause

The middle dot `·` is encoded in UTF-8 as bytes `0xC2 0xB7`. The arrow
`→` is `0xE2 0x86 0x92`. When a tool reads such a file as Latin-1, those
bytes appear as the two-/three-character sequences `Â·` and `â†→`. If
the tool then *re-writes* the file in UTF-8, each of those
single-byte-Latin-1 characters becomes its own UTF-8 sequence — the
double encoding. Likely vector here: one of the subagents read the
file via a non-UTF-8-aware path during a `replace` style edit.

## Solution

Detect with `rg` across the codebase, then fix-in-place via `Edit`:

```bash
# Detection pattern — these mojibake sequences should never appear in source.
rg 'Â·|â†|Ã©|Ã¼|Ã¶|Ã¤|Ã„|Ã–|Ãœ' apps/dashboard-web/src
```

For each hit, replace the mojibake sequence with the intended character:
`Â·` → `·`, `â†→` → `→`. Nine occurrences across two files in v1.6.1.

## Verification

After fixes, the same `rg` pattern returns no matches, and the QA
screenshot pass shows `·` and `→` rendering correctly in all 48
variants (12 routes × 2 themes × 2 locales).

## Lessons

- **Tests don't catch this.** Tsc, ESLint, Prettier, Vitest, and Playwright
  text-content assertions all pass on double-encoded UTF-8 because the
  bytes are valid UTF-8 and the strings still contain *some* character
  per code point. Only visual rendering reveals the mojibake.
- **Add the detection regex to your pre-commit or QA checklist** if you
  use multi-step agentic edits. The grep is cheap and catches the
  problem before users see it.
- **Multi-byte chars in source are a footgun for any toolchain that
  isn't strict about encodings.** Prefer Unicode escapes (`·`,
  `→`) in code paths that are heavily edited by tools, or — better —
  push these characters into i18n bundle JSON where the JSON parser
  enforces UTF-8 and the strings flow through `t(...)` instead of
  appearing as raw source-code literals.
