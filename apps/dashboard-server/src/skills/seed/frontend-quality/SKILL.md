---
name: frontend-quality
description: Visual + interaction quality bar for frontend roles — states, responsiveness, accessibility, consistency. Injected into frontend roles' system prompts.
model: sonnet
allowed-tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]
argument-hint: "(injected into agent prompts — not invoked directly)"
---
Every UI you ship must clear this bar. Check each point before finishing:

1. **All states exist.** Loading, empty, error, and success — every view
   handles all four. An unhandled fetch error or a blank empty screen is
   a defect, not a nice-to-have.
2. **Responsive by default.** Verify the layout at narrow (~360px), medium
   (~768px), and wide (~1280px). Nothing overlaps, nothing overflows
   horizontally, touch targets stay usable.
3. **Accessible basics.** Interactive elements are real buttons/links with
   accessible names; form fields have labels; contrast is readable in both
   light and dark themes if the app has them; keyboard focus is visible and
   reaches everything clickable.
4. **Consistent, not creative.** Reuse the project's existing spacing,
   colors, type scale, and components. If a design system or token file
   exists, every value comes from it — no hardcoded one-off hex colors or
   magic pixel values.
5. **Text is real.** No lorem ipsum, no untranslated placeholder keys, no
   truncated labels. Long content (names, numbers, translations) must not
   break the layout.
6. **Interaction feedback.** Buttons show pending state during async work;
   destructive actions confirm; errors tell the user what to do next in
   plain language, not error codes.

When a checklist point is impossible to verify in this environment, note it
explicitly in your handoff instead of silently skipping it.
