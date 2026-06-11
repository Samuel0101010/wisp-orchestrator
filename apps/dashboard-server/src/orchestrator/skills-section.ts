import type { SkillRegistry } from '../skills/registry.js';

/**
 * Hard cap on the rendered "## Skills" section. Eight maximally-verbose
 * skills must not drown the actual task; skills that don't fit are listed
 * by name so the agent (and anyone reading the prompt) knows they exist.
 */
export const MAX_SKILLS_SECTION_CHARS = 12_000;

/**
 * Render the named skills into the markdown section the walker appends to an
 * executing agent's system prompt. Pure + best-effort by contract
 * (WalkerDeps.renderSkillsSection): unknown names are skipped silently —
 * a team may reference skills that aren't installed on this machine — and
 * an empty result means "no section".
 */
export function renderSkillsSection(
  skillNames: string[],
  registry: Pick<SkillRegistry, 'get'> | undefined,
): string {
  if (!registry || skillNames.length === 0) return '';
  const blocks: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const name of skillNames) {
    const skill = registry.get(name);
    if (!skill || skill.systemPrompt.trim().length === 0) continue;
    const block = `### Skill: ${skill.name}\n${skill.systemPrompt.trim()}`;
    if (used + block.length > MAX_SKILLS_SECTION_CHARS) {
      omitted.push(skill.name);
      continue;
    }
    blocks.push(block);
    used += block.length;
  }
  if (blocks.length === 0) return '';
  const header =
    '## Skills\n' +
    'Apply the following skills while you work. They are mandatory working practice for your role, not optional suggestions.';
  const tail =
    omitted.length > 0 ? `\n\n(Assigned but omitted for length: ${omitted.join(', ')})` : '';
  return `${header}\n\n${blocks.join('\n\n')}${tail}`;
}
