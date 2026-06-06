// WISP brand palette, derived from the dashboard's dark-theme design tokens
// (apps/dashboard-web/src/styles/wisp-theme.css): warm charcoal-brown ground,
// cream foreground, a single coral accent. Hex values are the HSL tokens
// resolved to sRGB.
export const COLORS = {
  bg: '#18120C', // hsl(31 33% 7%)  — app background
  bgDeep: '#0E0B07', // a touch deeper, for the video ground
  bgElevated: '#241B12', // card / chrome surfaces
  card: '#211911',
  cardBorder: '#3A2E22',
  cardBorderBright: '#4D3D2D',
  fg: '#F6F0E4', // hsl(38 49% 93%) — foreground
  muted: '#B3A38C',
  faint: '#6F6353',
  coral: '#D97959', // hsl(15 63% 60%) — primary accent
  coralBright: '#EC9474',
  coralDeep: '#B85C3E',
  amber: '#EBB270', // hsl(32 75% 68%) — warning
  gold: '#C9A24A', // wordmark gold
  green: '#6CC08A', // success
  blue: '#7CA7C8',
} as const;

export const FPS = 30;
