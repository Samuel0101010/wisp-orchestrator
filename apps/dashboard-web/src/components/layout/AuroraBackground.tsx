/**
 * App background — a flat, fixed base layer behind the app chrome.
 *
 * DESIGN.md forbids gradient / aurora / mesh backgrounds ("Aurora im Background
 * = nicht okay"), so this renders a single flat `--wisp-bg-0` wash: no radial
 * gradient, no drifting coral blob, no grain. `aria-hidden` — no semantic
 * content. (Name kept for the existing import in App.tsx.)
 */
export function AuroraBackground() {
  return <div className="wisp-aurora-root" aria-hidden="true" />;
}
