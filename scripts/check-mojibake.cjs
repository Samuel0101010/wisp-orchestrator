#!/usr/bin/env node
/**
 * Mojibake guardrail.
 *
 * Detects double-encoded UTF-8 (UTF-8 -> Latin-1 -> UTF-8) that has slipped
 * into the source tree. Text-based gates (tsc / eslint / prettier / vitest /
 * playwright text matchers) all see mojibake bytes as valid UTF-8 and pass.
 * Only screenshot review catches it; this script is the CI-level catch.
 *
 * The detection patterns are constructed from explicit \uXXXX escapes (rather
 * than literal extended-ASCII characters with embedded U+0080 control bytes).
 * That keeps the SOURCE of this file mojibake-free, prettier-stable, and
 * robust against editors that silently normalise non-printables. This file is
 * also excluded from the scan via the SELF check below.
 *
 * Signatures (Unicode codepoint pairs that appear in the file after re-reading
 * as UTF-8):
 *
 *   U+00C2 + U+0080..U+00BF             Mojibake of 2-byte UTF-8 (middot, NBSP).
 *   U+00C3 + U+0080..U+00BF             Mojibake of Latin-1 high-half
 *                                       (e-acute, u-umlaut, ...). Real German
 *                                       letters U+00C4/D6/DC/DF/E4/F6/FC are
 *                                       single codepoints, never C3-prefixed
 *                                       pairs, so no false positives.
 *   U+00E2 + (U+0080..U+00BF |
 *             U+2000..U+20FF)           Mojibake of 3-byte UTF-8 (em-dash,
 *                                       ellipsis, arrows, box-drawing).
 *   U+00F0 + U+0178                     Mojibake of 4-byte UTF-8 (emoji prefix).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const ROOTS = [
  path.join(repoRoot, 'apps', 'dashboard-web', 'src'),
  path.join(repoRoot, 'apps', 'dashboard-server', 'src'),
  path.join(repoRoot, 'packages'),
  path.join(repoRoot, 'tests'),
];

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.turbo',
  'playwright-report',
  'test-results',
  '.cache',
  'coverage',
]);

const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.html', '.json']);

const PATTERNS = [
  {
    re: new RegExp('Â[-¿]', 'g'),
    label: 'C2 + low (mojibake 2-byte: middot/NBSP/...)',
  },
  {
    re: new RegExp('Ã[-¿]', 'g'),
    label: 'C3 + low (mojibake Latin-1 high: e-acute/u-umlaut/...)',
  },
  {
    re: new RegExp('â[-¿ -⃿]', 'g'),
    label: 'E2 + glyph (mojibake 3-byte: em-dash/arrow/box)',
  },
  {
    re: new RegExp('ðŸ', 'g'),
    label: 'F0 178 (mojibake 4-byte: emoji prefix)',
  },
];

const SELF = path.resolve(__filename);

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      if (ent.name.startsWith('.')) continue;
      walk(path.join(dir, ent.name), acc);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name);
      if (SCAN_EXTS.has(ext)) acc.push(path.join(dir, ent.name));
    }
  }
}

const files = [];
for (const root of ROOTS) walk(root, files);

const violations = [];
for (const file of files) {
  if (path.resolve(file) === SELF) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const { re, label } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(0, m.index);
      const lineNo = before.split('\n').length;
      // Render the matched codepoints as \uXXXX so CI logs don't themselves
      // get re-corrupted by terminals that mishandle UTF-8.
      const escaped = Array.from(m[0])
        .map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase())
        .join('');
      const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
      violations.push(`${rel}:${lineNo}\t${label}\t${escaped}`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    `encoding check: ${violations.length} mojibake match(es) in ${files.length} files:`,
  );
  for (const v of violations) console.error('  ' + v);
  console.error('');
  console.error('Hint: re-encode the offending file as UTF-8 or pull the multi-byte chars into a JSON bundle.');
  process.exit(1);
}
console.log(`encoding check: clean (${files.length} files scanned)`);
