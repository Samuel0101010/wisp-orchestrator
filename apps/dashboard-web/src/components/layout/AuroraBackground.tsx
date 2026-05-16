/**
 * Aurora — fixed warm ambient background that sits behind the app chrome.
 * Mirrors the Wisp design handoff (kSh9k4g-wVwW3DlwB6i7fw / aurora.jsx):
 * theme-aware radial wash, drifting coral accent blob, fine grain overlay.
 * `aria-hidden` because it carries no semantic content.
 */
export function AuroraBackground() {
  return (
    <div className="wisp-aurora-root" aria-hidden="true">
      <div className="wisp-aurora-accent" />
      <div className="wisp-aurora-grain" />
    </div>
  );
}
