# Product

## Register

**product**

WISP ist ein lokales Orchestrator-Tool für autonome Claude-Code-Agenten-Crews. Das Dashboard ist UI für ein Power-User-Werkzeug, keine Marketing-Site. Design *serves* das Produkt: dichte Live-Information (Plan-DAG, Kanban, Streaming-Tail, Token-Budget, Rate-Limit-Countdown), schnelle Loads, Hotkey-Coverage, ruhige Tonalität in stundenlangen Beobachtungs-Sessions. Es gibt keinen Brand-Modus / Marketing-Surface — die Distribution läuft über GitHub-README + Claude-Code-Plugin, nicht über eine Landing-Page.

## Users

**Primärer User:** Solo-Engineer (Senior, 8–20 Jahre Erfahrung), die Claude-Max-Subscription für ehrgeizige mehrstündige Coding-Sessions auf einem persönlichen Repo nutzen. Will eine *Crew* von 3–8 Agenten (Architect, Developer, QA, Reviewer) nicht nur einen einzelnen Agent. Lässt das Dashboard auf einem zweiten Monitor mit ständigem Auge auf Plan-Status, Token-Verbrauch und Rate-Limit-Fenster offen, während er primär in IDE oder Terminal arbeitet. Erwartet, dass er das Tool wegklicken und 3 Stunden später zurückkommen kann, ohne State zu verlieren.

**Sekundärer User:** Engineering-Manager / Tech-Leads, die Agenten-Workflows für ihr Team evaluieren — Read-Only-Beobachtung von Run-Verläufen, Plan-Diff-Reviews, QA-Replan-Audit-Trails. Nicht der primäre Optimierungs-Anker; das Tool darf ihn aber nicht ausschließen.

**Nicht-Zielgruppen:** Anfänger ohne Claude-Code-Erfahrung, Enterprise-Compliance-Teams, Non-Technical-PMs, GUI-First-User die SQLite-Pfade und CLI-Spawns als Last empfinden.

**Kontext:** Sessions sind 1–6h, oft asynchron — Run starten, Browser-Tab im Hintergrund, alle 10–30 min reinschauen. 14–32" Display, häufig dunkles Setup (60–70% Dark-Mode). User wechselt schnell zwischen IDE, Terminal, Claude-Code-CLI und Dashboard. Hasst Modal-Overlays, die Beobachtung unterbrechen. Reduced-Motion-User-Anteil signifikant (Power-User mit chronischer Bildschirmzeit).

## Product Purpose

WISP löst die Lücke zwischen Single-Agent-Chat-UIs (zu schmal), Black-Box-Orchestrators (Plan unsichtbar) und Notebook-Babysitting-Setups (zu fragil). Es liefert eine vertikale Slice: editierbare Team-Spec → DAG-Plan-Artifact → Live-Execution-Graph mit Persistenz über Rate-Limit-Pausen und Maschinen-Restarts hinweg.

**Erfolg:**

- User kann ein Goal eintippen, Plan-DAG generieren, locken, und das Dashboard 4h ungestört laufen lassen.
- Rate-Limit-Pause + Resume klappt zu 100% ohne Datenverlust.
- QA-Replan-Path zeigt sichtbar `v2 (replanned)` und ist im Audit-Trail nachvollziehbar.
- Keine versteckten API-Calls — die Compliance-Tests (`tests/compliance/`) bleiben grün.
- Ein neuer User kommt ohne Doku in <10 Minuten zu einem laufenden Run (FirstRunModal + sinnvolle Defaults).

## Brand Personality

**3 Worte:** technisch, präzise, beobachtbar.

**Voice & Tone:** Engineer-zu-Engineer. "Walker dispatched task X to worktree Y." statt "We're processing your request!". Keine Smileys, keine "magic", keine Marketing-Adjektive. Wenn etwas fehlschlägt: konkret was, konkret wo, konkret warum (verify-failed-Payload mit voller Output-Capture). Status-Strings sind imperativ und kurz — *running*, *pending*, *queued*, *blocked*, *succeeded*, *failed*.

**Emotional Goal:** Vertrauen durch Transparenz. Der User soll fühlen: "Ich sehe genau, was passiert. Nichts wird vor mir versteckt." Keine Animation, die Zustand vortäuscht, der nicht real ist. Loading-Skeletons spiegeln tatsächliches Layout, kein generischer Pulse.

**Aesthetic North Star:** Linear (Restrained-Cool, hairline-borders, monochrome+single-accent) als primärer Anchor. Sekundär: Vercel-Dashboard-Ästhetik für die Run-Detail-Views (dichter, mehr Mono-Typografie, Stripe-style Progress-Animationen). Mission-Control-Redesign (v1.2) hat diesen Linear-Cockpit-Hybrid bereits etabliert.

## Anti-references

- **Trello / Asana / Linear-Issues** — Tasks sind hier *Agent-Subprozesse*, keine User-Tickets. Avatare, Assignee-Pickers, Comment-Threads sind fehl am Platz.
- **Generic-AI-Aesthetic 2025** — Gradient-Hero, Glassmorphism, lila Akzente, "✨ AI-powered"-Badges. Wir sind ein Werkzeug für Leute, die AI bauen, nicht ein AI-Wrapper-Marketing-Stunt.
- **n8n / Zapier-Workflow-Builder** — bunte runde Knoten mit Drop-Shadows. Unser DAG ist ein React-Flow-Graph, aber visuell terse: hairline-borders, monochrome Knoten, Status nur über Border-Color + Icon.
- **VSCode-Activity-Bar-Clones** — der Sidebar ist ein Navigations-Kontext, kein Multi-Pane-Workspace. Keine kollabierbaren Multi-Level-Trees.
- **Dashboard-Bento-Grids mit Aurora-Hintergrund** — Mission Control ist ein Cockpit, kein Hero-Screenshot.
- **Toast-Spam.** Erfolgs-Toasts nur, wenn der User die Aktion *aktiv* ausgelöst hat (Lock & Run = ja, Auto-Reconnect = nein).

## Design Principles

1. **Beobachtbarkeit zuerst.** Jeder Pixel-Square muss Information tragen oder Information dichter machen. Dekoration ohne semantische Funktion ist verboten. Border-Beam auf aktivem Run-Card = okay (signalisiert Aktivität); Aurora im Background = nicht okay.
2. **Defaults sind Entscheidungen.** Sensible Modelle (opus für Architect/Planner, sonnet für Developer/QA), `maxParallel=2`, `budgetMinutes=120`. Templates sind opinionated. User passt an, wenn nötig.
3. **Speed-of-thought.** Cmd-K-Palette als Primary-Input, Hotkeys auf >70% aller Aktionen, sichtbare Hint-Mono-Glyphs (`⌘K`, `Esc`).
4. **Density that breathes.** Kanban-Cards sind dicht (Status-Dot + Title + Mono-ID + Token-Counter), aber mit Vertical-Rhythm-Atempausen zwischen Sektionen. Nie alles flach.
5. **Persistence is a feature.** Rate-Limit-Countdown, Plan-Version-Badges, Resume-Pfade — der User sieht *immer*, in welchem Zustand der Server ist, auch nach Browser-Refresh.
6. **Status-Color is semantic, not decorative.** Architect=blau, Developer=grün, QA=amber. Failure=rot, Success=grün. Status wird zusätzlich über Icon+Text kodiert (Color-Blindness).
7. **Tabular-nums für alle Zahlen.** Token-Counter, Run-IDs, Durations, Cost-Estimates — alles `font-variant-numeric: tabular-nums`, damit Spalten-Widths stabil bleiben während Live-Updates.

## Accessibility & Inclusion

**WCAG 2.2 AA Minimum.** Body-Kontrast in beiden Modi ≥7:1 (AAA-Niveau). Status-Dots haben begleitenden Text (Screen-Reader liest "running", nicht nur den Dot).

**Bekannte User-Needs:**

- **Reduced-Motion** durchgehend respektiert. Border-Beam, AnimatedCounter, alle non-essential Auto-Animations werden no-op (`@media (prefers-reduced-motion: reduce)`).
- **Keyboard-Nav-First.** Cmd-K öffnet Palette, Esc schließt Modals, Tab-Order stabil. Visible Focus-Ring (2px outline, ≥3:1 Kontrast).
- **Screen-Reader:** Korrekte Landmarks (`<main>`, `<nav aria-label>`), Live-Regions für Toasts (`aria-live="polite"`), `aria-current="page"` für aktive Sidebar-Items.
- **Color-Blindness:** Status-Indikatoren haben Icon + Text (`<CheckCircle/> Succeeded`), nie nur Color.

**Touch-Targets:** ≥36×36px für Icon-Buttons (Power-User-Maus-Kontext, dokumentiert). ≥44×44px für Primary-CTAs (Lock & Run).

**Sprache:** Default Englisch (Engineering-Tool, internationale User). Deutsche Übersetzung vorhanden via `i18next` (siehe `apps/dashboard-web/src/i18n/`). Sprach-Toggle im Header. Strings als i18n-Keys gepflegt — keine hardgecodeten User-Facing-Strings in Components.

**Browser-Support:** Last-2-Versions Chrome/Edge/Firefox/Safari. Kein IE11. CSS-Features: HSL-Tokens (OKLCH-Migration ist offene Designentscheidung, siehe DESIGN.md), `backdrop-filter` mit graceful-degradation.

## Scope-Anchor für Impeccable

Wenn `/impeccable shape` oder `/impeccable craft` ohne expliziten Surface-Hinweis aufgerufen wird, ist die Default-Annahme: **`apps/dashboard-web/`** — also der Browser-Dashboard. Andere Surfaces (`packages/*` Library-APIs, CLI-Output, Doku-Markdown) sind nicht im Impeccable-Scope; verweise dort auf das passende Werkzeug.
