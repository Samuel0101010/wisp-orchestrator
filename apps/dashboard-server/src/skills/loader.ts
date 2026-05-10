import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { Skill, SkillFrontmatter } from './types.js';

export function loadSkillFromFile(filePath: string): Skill {
  const raw = readFileSync(filePath, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`Skill ${filePath}: missing frontmatter`);
  const fm = yaml.load(m[1]!) as SkillFrontmatter;
  if (!fm?.name || !fm?.description || !fm?.model || !Array.isArray(fm['allowed-tools'])) {
    throw new Error(
      `Skill ${filePath}: invalid frontmatter (need name, description, model, allowed-tools)`,
    );
  }
  return {
    name: fm.name,
    description: fm.description,
    model: fm.model,
    allowedTools: fm['allowed-tools'],
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
        console.warn(`[skills] skipped ${skillFile}:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return out;
}
