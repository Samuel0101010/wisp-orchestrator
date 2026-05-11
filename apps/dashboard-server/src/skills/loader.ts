import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { Skill, SkillFrontmatter } from './types.js';

const VALID_MODELS = new Set(['opus', 'sonnet', 'haiku']);

export class NotASkillError extends Error {
  constructor(filePath: string) {
    super(`Skill ${filePath}: no frontmatter (treating as not-a-skill)`);
    this.name = 'NotASkillError';
  }
}

/**
 * Parse a SKILL.md file. Only `name` + `description` are required; other
 * fields fall back to sensible defaults so we can discover Claude Code
 * skills from plugins/users that don't follow our strict 4-field shape.
 *
 * Throws `NotASkillError` if the file has no frontmatter at all — caller
 * should treat that as "this isn't a skill, just markdown" and skip
 * silently. Other parse failures throw a regular Error.
 */
export function loadSkillFromFile(filePath: string): Skill {
  const raw = readFileSync(filePath, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new NotASkillError(filePath);
  const fm = (yaml.load(m[1]!) ?? {}) as Partial<SkillFrontmatter>;
  if (!fm.name || !fm.description) {
    throw new Error(`Skill ${filePath}: frontmatter missing name or description`);
  }
  const model = fm.model && VALID_MODELS.has(fm.model) ? fm.model : 'sonnet';
  const allowedTools = Array.isArray(fm['allowed-tools']) ? fm['allowed-tools'] : [];
  return {
    name: fm.name,
    description: fm.description,
    model,
    allowedTools,
    argumentHint: fm['argument-hint'],
    timeoutMs: fm['timeout-ms'] ?? 180_000,
    systemPrompt: m[2]!.trim(),
    filePath,
  };
}

export function loadAllSkills(rootDir: string): Skill[] {
  const out: Skill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return [];
  }
  for (const e of entries) {
    const p = join(rootDir, e);
    if (statSync(p).isDirectory()) {
      const skillFile = join(p, 'SKILL.md');
      try {
        out.push(loadSkillFromFile(skillFile));
      } catch (err) {
        if (err instanceof NotASkillError) continue;
        console.warn(`[skills] skipped ${skillFile}:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return out;
}
