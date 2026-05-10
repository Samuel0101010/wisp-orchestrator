# Design — Agent Harness Dashboard

Konkretes Design-System für `apps/dashboard-web`. Bezug zu PRODUCT.md (Brand: technisch · präzise · beobachtbar · Anchor: Linear · Mode: dark-default).

Aktueller Stand: Mission-Control-Redesign (v1.2.0, May 2026) hat den Linear-Cockpit-Hybrid etabliert. shadcn/ui-Style-Tokens auf HSL-Basis, Tailwind v4-beta, Radix-Primitives. Dieses Doku ist *Beschreibung des Ist-Zustands + Leitplanken für Iteration* — nicht ein Greenfield-Spec.

## Visual Theme — wo welche Variant

| Route | Composition / Variant | Begründung |
|---|---|---|
| `/` (Home / Mission Control) | `dashboard-shell` · **cockpit** | Multi-Run-Übersicht. Dichte Run-Cards mit Status-Dot, Token-Counter, Cost-Estimate, optional Border-Beam für aktive Runs. |
| `/projects/:id` (ProjectDetail) | `dashboard-shell` · **detail** | Projekt-Kontext: Goal, Repo-Path, Run-Liste, "Neue Variante starten"-CTA. Etwas weniger dicht als Cockpit, mehr Whitespace. |
| `/projects/:id/team` (TeamBuilder) | `editor-shell` | Drag-Drop-Sortable-Cards (dnd-kit). Form-First-Layout, mehr Padding, Validation inline. |
| `/projects/:id/plan` (PlanEditor) | `graph-canvas` | React-Flow + dagre. Hairline-Knoten, Status über Border-Color, Side-Panel rechts für Edits. |
| `/projects/:id/runs/:runId` (RunView) | `dashboard-shell` · **stream** | Kanban + Streaming-Tail + Resource-Meters. Zwei-Spalten-Layout auf ≥1280px, gestapelt darunter. |

**Variant-Strategy:** Es gibt keinen `bold`/`glass`-Marketing-Mode. Alle Surfaces sind product-mode. Cockpit-Variant ist die default-dichte Option, Detail-Variant atmet etwas mehr für Lese-Sessions, Stream-Variant priorisiert Live-Updates.

## Color Palette

**Strategy:** Restrained-Cool mit Single-Accent. HSL-Tokens (shadcn/ui-Konvention). OKLCH-Migration ist eine offene Designentscheidung — siehe **Open Tokens** unten.

### Light-Mode Tokens (`index.css` `:root`)

| Token | HSL | Verwendung |
|---|---|---|
| `--background` | `0 0% 100%` | Page-BG |
| `--foreground` | `222.2 84% 4.9%` | Body-Text, Headings |
| `--card` | `0 0% 100%` | Run-Cards, Panel-Surfaces |
| `--card-foreground` | `222.2 84% 4.9%` | Card-Inhalt |
| `--muted` | `210 40% 96.1%` | Sidebar-Inset, Disabled-BG |
| `--muted-foreground` | `215.4 16.3% 46.9%` | Captions, Mono-IDs |
| `--border` | `214.3 31.8% 91.4%` | Hairlines, Dividers |
| `--primary` | `222.2 47.4% 11.2%` | CTAs, Lock-&-Run |
| `--accent` | `210 40% 96.1%` | Hover-States, Active-Nav |
| `--destructive` | `0 84.2% 60.2%` | Failure-States, Delete |
| `--success` | `142 71% 38%` | Succeeded-States, Border-Beam |
| `--warning` | `38 92% 45%` | Pending-Reviews, Rate-Limit-Countdown |
| `--info` | `217 91% 55%` | Replan-Badge, Architect-Hints |
| `--ring` | `222.2 84% 4.9%` | Focus-Outline (2px) |

### Dark-Mode (`index.css` `.dark`)

Higher-elevation = leicht heller (kein Shadow-Stacking, Linear-style):

- `--background`: `222.2 84% 4.9%` (Page)
- `--card`: `222.2 47% 7%` (one elevation up)
- `--popover`: `222 47% 7%`
- `--secondary`/`--muted`: `217.2 32.6% 17.5%` (zwei Stufen, für Sidebar-Hover und Inset-Inputs)
- `--foreground`: `210 40% 98%` (nicht pure white)

### Role Colors (Semantic, für Agent-Spec-Cards & Plan-Knoten)

| Token | Light HSL | Dark HSL | Verwendung |
|---|---|---|---|
| `--role-architect` | `217 91% 60%` | `217 91% 65%` | Architect-Rolle, Plan-Knoten-Border |
| `--role-developer` | `142 71% 45%` | `142 65% 55%` | Developer-Rolle, Border-Beam |
| `--role-qa` | `38 92% 50%` | `38 92% 60%` | QA-Rolle, Verify-States |

### Anti-Choices

- **Kein lila/violet Akzent.** Linear-Anchor ist blau-grau, nicht Notion-lila.
- **Kein pure black/white.** `oklch(11%)`/`oklch(95%)` als untere/obere Grenzen — derzeit als HSL `222 84% 4.9%`/`210 40% 98%` umgesetzt.
- **Kein Gradient-Background.** Aurora, Mesh-Gradient, animated-Hero-BG sind verboten.
- **Border-Beam ist die einzige erlaubte conic-gradient-Animation** und nur für aktive Run-Cards. Reduced-Motion-Off no-op.

### Open Tokens (Designentscheidungen)

- **OKLCH-Migration:** Impeccable's shared-design-laws fordern OKLCH. Aktuell HSL (shadcn-Default). Migration könnte über `@theme` mit `oklch()`-Werten und HSL-Fallback laufen. Risiko: Browser-Compat (Safari <16.4). **Status: offen.**
- **Tinted neutrals:** Aktuelle `--muted` und `--background` sind nicht in Brand-Hue getintet (chroma 0). Linear hat ~`oklch(... 0.005 240)` als Tint. Sanfter Refactor möglich, niedriges Regression-Risiko.

## Typography

**Stack:** System-UI-Fallback-Chain (`ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`). Kein custom Webfont — bewusst, weil das Plugin lokal läuft und keine externen Asset-Hosts haben soll.

**Mono-Stack:** ui-monospace via Tailwind's `font-mono`-Default. Genutzt für Run-IDs, Token-Counter, Hotkey-Hints, Streaming-Tail.

**Open Decision (`/impeccable typeset`):** Linear-Anchor nutzt Inter Display + Berkeley Mono. Wenn Self-Hosting akzeptabel ist (Vite kann via `@fontsource/inter` bundlen), wäre das ein on-brand-Upgrade. Aktuell **system-stack-only** — bewusste Reibungs-Reduktion für die Plugin-Distribution.

**Modular Scale:** Tailwind-Default (≈1.250 major-third). Für Cockpit-Density okay; für Project-Detail-Lese-Sessions evtl. zu eng — `/impeccable typeset` als Re-Choice offen.

| Tailwind | Pixel | Weight | Verwendung |
|---|---|---|---|
| `text-3xl` | 30px | 600 | Page-Titles (Project-Name auf ProjectDetail) |
| `text-2xl` | 24px | 600 | Section-Headings (Mission Control Run-Group) |
| `text-xl` | 20px | 600 | Card-Titles, Run-Name |
| `text-base` | 16px | 400 | Body-Default |
| `text-sm` | 14px | 400/500 | Sidebar-Items, Form-Labels, Kanban-Meta |
| `text-xs` | 12px | 500 | Status-Badges, Hotkey-Hints, Mono-IDs |

**Tabular-Nums Pflicht** für alle Live-Zahlen-Counter (Token-Verbrauch, Run-Duration, Rate-Limit-Countdown). Bereits via `index.css`-Layer für `.font-mono` und `[class~='tabular-nums']` aktiviert.

**Reading-Width:** Body-Paragraphs `max-w-prose` (≈65ch). Aktuell uneinheitlich angewandt — Iteration-Punkt für `/impeccable polish`.

## Spacing

Tailwind-v4-Defaults (4px-Base). **Vertical-Rhythm:**

- **Cockpit-Surfaces:** `py-6` für Sektionen, `gap-3` zwischen Run-Cards.
- **Detail/Editor-Surfaces:** `py-8`–`py-12` für mehr Atem.
- **Cards:** `p-4` (Cockpit) bzw. `p-6` (Detail).
- **Inline-Gap:** `gap-2` für Hotkey + Label, `gap-3` für Status-Dot + Title.

**Container-Width:**
- Mission Control (`/`): `max-w-7xl` (1280px) zentriert.
- ProjectDetail / RunView: full-width mit Sidebar (~256px) + Main (1fr).
- TeamBuilder / PlanEditor: full-width (Editor benötigen den Platz).

## Motion

**Tokens (bereits in `index.css`):**

| Token | Wert | Verwendung |
|---|---|---|
| `--duration-fast` | 75ms | Hover-Tints, Focus-Ring |
| `--duration-quick` | 150ms | Toggle, Tab-Switch |
| `--duration-base` | 200ms | Modal-Open, Toast-Enter |
| `--duration-slow` | 300ms | Page-Transition (selten, weil meist instant) |
| `--duration-slower` | 500ms | Replan-Badge-Reveal |
| `--ease-smooth` | cubic-bezier(0.32, 0.72, 0, 1) | Default für entry-Animations |
| `--ease-sharp` | cubic-bezier(0.4, 0, 0.2, 1) | State-changes |
| `--ease-spring` | cubic-bezier(0.5, 1.6, 0.4, 1) | Sehr selten — nur für AnimatedCounter-Endwerte |
| `--ease-power` | cubic-bezier(0.65, 0, 0.35, 1) | Loading-Shimmer |

**Reduced-Motion:** Pflicht-Respekt überall. Border-Beam, AnimatedCounter, alle Auto-Loops setzen `animation: none` unter `@media (prefers-reduced-motion: reduce)`.

**Anti-Patterns:**

- Kein Spring-Bouncing auf primären CTAs.
- Keine Parallax-Backgrounds.
- Keine Page-Transitions zwischen Routes (React-Router-Default = instant; gewollt).
- Keine "celebration"-Confetti bei Run-Success.

## Components — Existing Inventory

| Komponente | Pfad | Notes |
|---|---|---|
| Theme-Toggle | `components/ThemeToggle.tsx` | Light/Dark/System, persistiert in localStorage |
| Language-Toggle | `components/LanguageToggle.tsx` | EN/DE via i18next |
| Command-Palette | `components/CommandPalette.tsx` | cmdk-basiert, Cmd-K |
| FirstRunModal | `components/FirstRunModal.tsx` | Onboarding für leeren State |
| StatusDotBadge | `components/StatusDotBadge.tsx` | Pflicht-Pattern für jeden Status |
| PlanVersionBadge | `components/PlanVersionBadge.tsx` | `v2 (replanned)`-Indikator |
| AnimatedCounter | `components/AnimatedCounter.tsx` | Token-Counter, Cost-Estimate |
| TeamRoleCard / SortableTeamRoleCard | `components/Team*.tsx` | dnd-kit-basiert |
| BackToProject | `components/BackToProject.tsx` | Back-Nav-Pattern |
| `ui/*` | `components/ui/` | shadcn/ui-Primitives (Button, Card, Dialog, Tabs, …) |

**Convention:** Neue Components folgen shadcn-Pattern (CVA für Variants, Radix-Slot wenn Composability nötig). Keine eigene Component-Library-Indirektion.

## Layout & Navigation

- **Sidebar:** Fixed-left, 256px wide auf ≥1024px, einklappbar darunter. Sektionen: Projects-Liste, Settings.
- **Topbar:** Sticky, blurry-backdrop (`.topbar-blur`), enthält: Cmd-K-Trigger, Theme-Toggle, Language-Toggle, optional Run-Status-Strip.
- **Breadcrumbs:** ProjectDetail und tieferen Pages — minimal, mono-typed Route-Segments.
- **Footer:** Keiner. Power-User-Tool, kein Marketing-Footer-Bedarf.

## Iconography

**Lucide-React** als einzige Icon-Library. Konvention: Stroke-only, 16–20px, `currentColor` für Vererbung. Status-Icons: `<Loader2 className="animate-spin" />` (running), `<CheckCircle2 />` (success), `<XCircle />` (failure), `<Clock />` (pending), `<Pause />` (paused).

**Anti:** Keine emoji-Icons in der UI. Keine multi-color SVGs. Keine animated GIFs.

## Empty States

- **Mission Control leer:** FirstRunModal mit "Create your first project"-CTA. Keine Illustration — nur Heading, kurzer Text, Button.
- **Run-Liste leer:** "Generate plan to start your first run." — knapp, mit Action.
- **Streaming-Tail leer:** Mono-Placeholder "Waiting for first task event…" mit pulsierendem Dot.

**Anti:** Keine Cartoon-Maskottchen, keine "It's lonely here!"-Texte.

## Open Iteration Surfaces (für Impeccable)

Diese Bereiche sind bewusst noch nicht final und gute Targets für `/impeccable craft`, `/impeccable polish`, `/impeccable critique`:

1. **Mission Control Run-Cards** — Border-Beam funktioniert, aber Information-Hierarchie könnte dichter (mehr Mono-Meta auf einer Zeile).
2. **PlanEditor-Knoten** — React-Flow-Knoten sind funktional, aber typografisch dünn. Status-Color als linker Border-Stripe statt full-Border evtl. leserlicher.
3. **TeamBuilder-Drag-Handles** — sichtbar nur on-hover, könnten Power-User mit Hotkey schneller machen (Alt+↑/↓).
4. **RunView-Streaming-Tail** — derzeit `<pre>` mit Tail-Auto-Scroll. Code-Highlighting für `claude -p`-Frames + collapse-pro-Tool-Use-Block sind offen.
5. **Resource-Meter** — Token-Bar + Rate-Limit-Countdown sind getrennte Components; visuelle Konsolidierung als ein Cockpit-Strip wäre stärker.
6. **OKLCH-Migration** — siehe Color-Palette-Open-Tokens.
7. **Typeset-Re-Choice** — siehe Typography-Open-Decision.
