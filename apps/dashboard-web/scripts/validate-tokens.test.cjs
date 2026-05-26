'use strict';
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, 'validate-tokens.cjs'), 'utf8');
const m = script.match(/const allowFiles = new Set\(\[([^\]]+)\]\)/);
if (!m) {
  console.error('validate-tokens.cjs: allowFiles set not found');
  process.exit(1);
}
const count = (m[1].match(/path\.join/g) ?? []).length;
// v1.15.1 — raised from 5 to 7 to cover preview-inspector.ts (iframe-injected
// inline-style hex literals, can't use CSS vars) + OrgChartView.test.tsx
// (snapshot fixture asserts a specific hex). Both landed in Phases 4-5.
// Wisp re-skin — raised to 8 for routes/Goap.tsx (3-column SVG canvas needs
// a viewport-height container under the topbar).
// v2.0.13 — raised to 9 for routes/Focusboard.tsx (workspace shell with
// 3-column viewport-height layout, same pattern as Home/Chat/RunView).
const MAX_ALLOWED = 9;
if (count > MAX_ALLOWED) {
  console.error(
    `validate-tokens.cjs allowFiles grew past ${MAX_ALLOWED}: ${count}. Re-justify before raising.`,
  );
  process.exit(1);
}
console.log(`validate-tokens.cjs allowFiles: ${count}/${MAX_ALLOWED} — ok`);
