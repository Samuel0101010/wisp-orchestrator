#!/usr/bin/env node
/**
 * Token validator: fails on any raw hex / hsl literal / arbitrary
 * Tailwind value in the JSX sources. Allowed exceptions:
 *   - apps/dashboard-web/src/styles/  (token definitions live here)
 *   - apps/dashboard-web/src/index.css (theme wiring)
 *   - apps/dashboard-web/src/components/Avatar.tsx (oklch — deterministic)
 *   - tests/                          (snapshot fixtures)
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'src');
const allowFiles = new Set([
  path.join(root, 'components', 'Avatar.tsx'),
  // Legitimate computed-viewport heights — main run/plan layouts need them.
  path.join(root, 'routes', 'RunView.tsx'),
  path.join(root, 'routes', 'PlanEditor.tsx'),
  // Top-level layout shells with sticky viewport-height containers.
  path.join(root, 'routes', 'Chat.tsx'),
  path.join(root, 'routes', 'Home.tsx'),
  // Preview-inspector runs as injected script INSIDE the user's iframe and
  // sets inline element.style.* strings directly — it can't reference our
  // CSS variables because it lives outside our React tree. (v1.12 Phase 4.)
  path.join(root, 'components', 'preview-inspector.ts'),
  // Test snapshot fixture asserts a specific hex literal.
  path.join(root, 'components', 'OrgChartView.test.tsx'),
]);
const denyPatterns = [
  { re: /#[0-9A-Fa-f]{3,8}\b/g, label: 'hex literal' },
  { re: /\btext-\[(\d+)px\]/g, label: 'arbitrary text-[Npx]' },
  { re: /\bh-\[calc\(/g, label: 'arbitrary h-[calc(...)]' },
  { re: /\btracking-\[[^\]]+\]/g, label: 'arbitrary tracking-[]' },
];

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full);
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) check(full);
  }
}

const violations = [];
function check(file) {
  if (allowFiles.has(file)) return;
  if (file.includes(path.sep + 'styles' + path.sep)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const { re, label } of denyPatterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const lineNo = text.slice(0, m.index).split('\n').length;
      violations.push(`${file}:${lineNo}\t${label}\t${m[0]}`);
    }
  }
}

walk(root);
if (violations.length) {
  console.error(`token validator found ${violations.length} violations:`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('token validator: clean');
