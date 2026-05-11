/**
 * Multi-source skill discovery. Walks the four conventional Claude Code
 * skill locations and returns a flat, name-deduped list with each skill
 * tagged by its origin. First-loaded wins on collisions; processing
 * order is (seed → project → user → plugin) so built-ins and explicitly
 * project-scoped skills shadow user-global and plugin-bundled ones.
 *
 * The plugin cache layout used by Claude Code is:
 *   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>/SKILL.md
 * Some plugins have multiple versions cached side-by-side; we take the
 * lexically-greatest version per plugin (good-enough proxy for "newest").
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillFromFile } from './loader.js';
import type { Skill, SkillSource } from './types.js';

export interface DiscoveryOpts {
  /** Project root to look for `.claude/skills/`. If unset, the project source is skipped. */
  projectRoot?: string;
  /** Override the built-in seed directory. Default: `<this-file>/seed` shipped with the harness. */
  seedRoot?: string;
  /** Override `os.homedir()`. Useful for tests. */
  homeDir?: string;
  /** Override the plugins cache root. Default: `<homeDir>/.claude/plugins/cache`. */
  pluginsCacheRoot?: string;
  /** Override the user skills dir. Default: `<homeDir>/.claude/skills`. */
  userSkillsDir?: string;
}

export interface DiscoveryStats {
  loaded: number;
  shadowed: { name: string; source: SkillSource; shadowedBy: SkillSource }[];
}

function listDirs(p: string): string[] {
  try {
    return readdirSync(p).filter((e) => {
      try {
        return statSync(join(p, e)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function loadSkillsFromRoot(root: string, source: SkillSource): Skill[] {
  const out: Skill[] = [];
  for (const entry of listDirs(root)) {
    const skillFile = join(root, entry, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    try {
      const s = loadSkillFromFile(skillFile);
      out.push({ ...s, source });
    } catch (err) {
      console.warn(
        `[skills:discovery] skipped ${skillFile}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return out;
}

function defaultSeedRoot(): string {
  // From dist/skills/discovery.js → ../seed (sibling of compiled discovery.js)
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'seed');
}

/**
 * Discover skills across all known sources. Returns the merged, deduped
 * list (each skill tagged with `source`) plus stats describing what got
 * shadowed.
 */
export function discoverSkills(opts: DiscoveryOpts = {}): {
  skills: Skill[];
  stats: DiscoveryStats;
} {
  const home = opts.homeDir ?? homedir();
  const seedRoot = opts.seedRoot ?? defaultSeedRoot();
  const userSkillsDir = opts.userSkillsDir ?? join(home, '.claude', 'skills');
  const pluginsCacheRoot = opts.pluginsCacheRoot ?? join(home, '.claude', 'plugins', 'cache');
  const projectSkillsDir = opts.projectRoot ? join(opts.projectRoot, '.claude', 'skills') : null;

  const out: Skill[] = [];
  const seen = new Map<string, SkillSource>();
  const stats: DiscoveryStats = { loaded: 0, shadowed: [] };

  const addAll = (skills: Skill[]): void => {
    for (const s of skills) {
      const prev = seen.get(s.name);
      if (prev) {
        stats.shadowed.push({
          name: s.name,
          source: s.source ?? 'seed',
          shadowedBy: prev,
        });
        continue;
      }
      seen.set(s.name, s.source ?? 'seed');
      out.push(s);
      stats.loaded += 1;
    }
  };

  // 1. Built-in seed skills (ship with the harness).
  addAll(loadSkillsFromRoot(seedRoot, 'seed'));

  // 2. Project-local skills (the user's repo).
  if (projectSkillsDir && existsSync(projectSkillsDir)) {
    addAll(loadSkillsFromRoot(projectSkillsDir, 'project'));
  }

  // 3. User-global skills.
  if (existsSync(userSkillsDir)) {
    addAll(loadSkillsFromRoot(userSkillsDir, 'user'));
  }

  // 4. Plugin cache: pick the lexically-greatest version per plugin.
  if (existsSync(pluginsCacheRoot)) {
    for (const marketplace of [...listDirs(pluginsCacheRoot)].sort()) {
      const marketDir = join(pluginsCacheRoot, marketplace);
      for (const pluginName of [...listDirs(marketDir)].sort()) {
        const pluginDir = join(marketDir, pluginName);
        const versions = [...listDirs(pluginDir)].sort();
        const latest = versions[versions.length - 1];
        if (!latest) continue;
        const skillsDir = join(pluginDir, latest, 'skills');
        if (!existsSync(skillsDir)) continue;
        addAll(loadSkillsFromRoot(skillsDir, `plugin:${pluginName}` as SkillSource));
      }
    }
  }

  return { skills: out, stats };
}
