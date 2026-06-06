// Brand fonts. Instrument Sans is the WISP dashboard's own typeface; JetBrains
// Mono backs the install-terminal block. loadFont() registers Remotion
// delayRender handles internally so the renderer waits for the webfonts.
import { loadFont as loadSans } from '@remotion/google-fonts/InstrumentSans';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';

export const { fontFamily: SANS } = loadSans('normal', {
  weights: ['400', '500', '600', '700'],
  subsets: ['latin'],
});

export const { fontFamily: MONO } = loadMono('normal', {
  weights: ['400', '500', '700'],
  subsets: ['latin'],
});
