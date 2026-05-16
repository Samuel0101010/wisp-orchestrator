/**
 * Deterministic role → color mapping. Roles are free-form kebab-case strings
 * (see `Role = string` in @wisp/schemas), so we can't enumerate them.
 * Canonical roles get curated colors; arbitrary roles fall back to a stable
 * hash bucket. All values picked so white text on the color passes WCAG-AA
 * (lightness ≤ ~45%), making the badge readable in both themes.
 */

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
  '217 91% 42%',
  '142 71% 32%',
  '30 92% 38%',
  '262 71% 42%',
  '180 71% 32%',
  '340 71% 42%',
  '24 91% 38%',
  '199 89% 32%',
];

function hashRole(role: string): number {
  let h = 0;
  for (let i = 0; i < role.length; i++) {
    h = (h * 31 + role.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function roleHslTriplet(role: string): string {
  const canonical = CANONICAL[role];
  if (canonical) return canonical;
  const idx = hashRole(role) % FALLBACK_PALETTE.length;
  return FALLBACK_PALETTE[idx] ?? FALLBACK_PALETTE[0]!;
}

export function roleHsl(role: string): string {
  return `hsl(${roleHslTriplet(role)})`;
}

export function roleStripeStyle(role: string): { background: string } {
  return { background: roleHsl(role) };
}

/**
 * Returns inline style for a low-chroma tinted role pill — readable in both
 * themes. Uses opacity-modulated saturated color: the semi-transparent bg
 * lets the theme background (light card / dark card) bleed through, so the
 * pill adapts automatically without per-theme overrides.
 */
export function rolePillStyle(role: string): {
  background: string;
  color: string;
  borderColor: string;
} {
  const triplet = roleHslTriplet(role);
  return {
    background: `hsl(${triplet} / 0.12)`,
    color: `hsl(${triplet})`,
    borderColor: `hsl(${triplet} / 0.25)`,
  };
}
