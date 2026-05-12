---
date: 2026-05-12
tags: [tailwind, design-tokens, type-safety, css-variables, schema-vs-css]
files:
  - apps/dashboard-web/src/lib/role-color.ts
  - apps/dashboard-web/src/components/plan/PlanCanvas.tsx
  - apps/dashboard-web/src/routes/RunView.tsx
  - apps/dashboard-web/src/index.css
related:
  - 2026-05-12-shadcn-translucent-tint-with-foreground-token-invisible.md
---

# `hsl(var(--role-${id}))` pattern breaks for free-form string types — use a JS palette instead

## Problem

In the Plan Editor canvas and Run View kanban, role badges (`BACKEND-DEV`,
`QA-ENGINEER`) and the colored left-stripe on task cards rendered with
no fill at all in light theme — invisible white-on-white. The bug only
showed up for non-canonical roles like `backend-dev` and `qa-engineer`;
the legacy hardcoded `architect | developer | qa` looked correct because
the matching CSS variables existed.

An earlier "contrast fix" agent had darkened the three role tokens in
`:root` (`--role-architect: 217 91% 42%`, etc.), but that fix never
reached the actual roles in our plans.

## Root cause

Two anti-patterns layered on top of each other:

1. **Schema** declared `type Role = string` (free-form kebab-case), so any
   role name is valid at runtime.
2. **Render code** interpolated the role into a CSS variable name:

   ```tsx
   // PlanCanvas.tsx
   function roleAccent(role: Role) {
     return `hsl(var(--role-${role}))`;
   }
   ```

   And `RunView.tsx` had a hardcoded `Record<TaskRole, string>` map for
   the same set of 3 names.

   The CSS file (`index.css`) only defined `--role-architect`,
   `--role-developer`, `--role-qa`. For any role outside that set, the
   variable is undefined, `hsl(var(--role-backend-dev))` evaluates to
   no color, and the badge/stripe gets no background — transparent on
   the white card background = invisible.

## Solution

Move from "one CSS variable per id" to a deterministic JS palette that
handles both canonical and unknown roles. New file
`apps/dashboard-web/src/lib/role-color.ts`:

```ts
const CANONICAL: Record<string, string> = {
  architect: '217 91% 42%',
  developer: '142 71% 32%',
  qa: '30 92% 38%',
  'backend-dev': '217 91% 42%',
  'frontend-dev': '262 71% 42%',
  'qa-engineer': '30 92% 38%',
  reviewer: '180 71% 32%',
  manager: '215 28% 30%',
};

const FALLBACK_PALETTE = [
  '217 91% 42%', '142 71% 32%', '30 92% 38%', '262 71% 42%',
  '180 71% 32%', '340 71% 42%', '24 91% 38%', '199 89% 32%',
];

function hashRole(role: string): number {
  let h = 0;
  for (let i = 0; i < role.length; i++) h = (h * 31 + role.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function roleHsl(role: string): string {
  const canonical = CANONICAL[role];
  if (canonical) return `hsl(${canonical})`;
  const idx = hashRole(role) % FALLBACK_PALETTE.length;
  return `hsl(${FALLBACK_PALETTE[idx] ?? FALLBACK_PALETTE[0]!})`;
}

export function roleStripeStyle(role: string): { background: string } {
  return { background: roleHsl(role) };
}
```

`PlanCanvas.tsx` and `RunView.tsx` now both call `roleHsl()` /
`roleStripeStyle()`. The orphaned `--role-*` variables were removed
from `index.css`.

All palette entries have lightness ≤ 45 %, so white text on the
saturated background passes WCAG-AA in both themes (the badge surface
is theme-independent — its color *is* the surface).

## Verification

Eight targeted screenshots (`/plan` + `/run` × light/dark × en/de) after
the change show the BACKEND-DEV (blue) and QA-ENGINEER (amber) badges
+ stripes rendering clearly in every variant. Files at
`audit-artifacts/screenshots/v1.6.0-final-{plan,run}-*.png`.

Also typechecks cleanly (`tsc -b`) with strict
`noUncheckedIndexedAccess` — the `FALLBACK_PALETTE[idx] ?? FALLBACK_PALETTE[0]!`
fallback satisfies the type checker.

## Lessons

- **CSS-variable-per-id is only safe when the id space is a closed
  enum** that's authored alongside the CSS. If the type is `string` or
  the values come from user data, runtime lookup will hit holes.
- **Two surfaces, one helper.** Before the fix, PlanCanvas had
  `hsl(var(...))` and RunView had a Tailwind `Record<Role, string>`.
  Both were independently broken. A shared `lib/role-color.ts` removed
  the divergence and made future role additions a 1-line palette edit.
- **Theme-independent surface trick:** for elements whose *color is the
  surface itself* (badges, stripes), pick lightness ≤ 45 % so white
  foreground reads in both themes — no `:root` vs `.dark` overrides
  needed. Saves a whole layer of variables for surfaces that don't
  need to adapt to the page background.
- **Token-validator scope was too narrow.** Our `validate-tokens.cjs`
  denies hex literals and arbitrary text-sizes but didn't catch the
  undefined-variable case. Consider an extension: warn when
  `var(--<prefix>-${...})` appears inside a JS template literal where
  `<prefix>` doesn't have a full canonical set defined.
