// Renders a dense grid of stills across the timeline for visual review.
// Bundles ONCE, then renders many frames fast (no per-still re-bundle).
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const COMP = process.argv[2] ?? 'promo-landscape';
const OUT = path.resolve('out', 'grid');

// Pass an explicit comma-separated frame list as argv[3] (e.g. one per scene),
// otherwise fall back to a regular sweep across the full ~98s timeline.
const FRAMES = [];
if (process.argv[3]) {
  for (const f of process.argv[3].split(',')) FRAMES.push(Number(f));
} else {
  for (let f = 15; f < 2940; f += 50) FRAMES.push(f);
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  console.log('bundling...');
  const serveUrl = await bundle({ entryPoint: path.resolve('src', 'index.ts') });
  const composition = await selectComposition({ serveUrl, id: COMP });
  console.log(`rendering ${FRAMES.length} frames of ${COMP}`);

  for (const frame of FRAMES) {
    const output = path.join(OUT, `${COMP}-${String(frame).padStart(4, '0')}.png`);
    await renderStill({ composition, serveUrl, output, frame, imageFormat: 'png' });
    process.stdout.write(`  ${frame}\n`);
  }
  console.log('GRID DONE');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
