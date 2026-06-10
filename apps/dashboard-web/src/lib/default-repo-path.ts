/**
 * Derives the suggested repo path for a new project from its name, so the
 * "Repo path" field in the new-project dialogs can auto-fill while the user
 * hasn't touched it. Pure string logic — the base directory + separator come
 * from GET /api/projects/default-repo-base (see useDefaultRepoBase).
 */

/**
 * Folder-safe slug from a project name: lowercase, German umlauts folded
 * (ä→ae ö→oe ü→ue ß→ss), remaining accents transliterated (é→e, à→a) via
 * NFD + combining-mark strip, every run of other disallowed chars collapsed
 * to a single '-', trimmed, capped at 40 chars. Empty input falls back to
 * 'wisp-app' so the path never ends in the bare base directory.
 */
export function slugifyProjectName(name: string): string {
  const slug = name
    .toLowerCase()
    // Umlauts must fold BEFORE the NFD strip, or the strip would reduce them to the bare base letter.
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'wisp-app';
}

/** Joins the server-provided base dir + separator with the slugified name. */
export function defaultRepoPath(base: string, sep: string, name: string): string {
  const trimmedBase = base.endsWith(sep) ? base.slice(0, base.length - sep.length) : base;
  return `${trimmedBase}${sep}${slugifyProjectName(name)}`;
}
