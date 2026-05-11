import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Bundle = Record<string, unknown>;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const localesDir = path.join(repoRoot, 'apps', 'dashboard-web', 'src', 'i18n', 'locales');

function loadBundle(lang: 'en' | 'de'): Bundle {
  const file = path.join(localesDir, lang, 'common.json');
  return JSON.parse(readFileSync(file, 'utf8')) as Bundle;
}

const cache = new Map<'en' | 'de', Bundle>();

/** Resolve a dotted key like `buttons.saveTeam` against the locale's bundle. */
export function tt(
  lang: 'en' | 'de',
  key: string,
  vars: Record<string, string | number> = {},
): string {
  let bundle = cache.get(lang);
  if (!bundle) {
    bundle = loadBundle(lang);
    cache.set(lang, bundle);
  }
  const parts = key.split('.');
  let cur: unknown = bundle;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') throw new Error(`tt: missing key ${key} in ${lang}`);
    cur = (cur as Record<string, unknown>)[p];
  }
  if (typeof cur !== 'string') throw new Error(`tt: key ${key} in ${lang} is not a string`);
  return cur.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? `{{${k}}}`));
}
