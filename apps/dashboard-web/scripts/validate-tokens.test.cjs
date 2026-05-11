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
const MAX_ALLOWED = 5;
if (count > MAX_ALLOWED) {
  console.error(
    `validate-tokens.cjs allowFiles grew past ${MAX_ALLOWED}: ${count}. Re-justify before raising.`,
  );
  process.exit(1);
}
console.log(`validate-tokens.cjs allowFiles: ${count}/${MAX_ALLOWED} — ok`);
