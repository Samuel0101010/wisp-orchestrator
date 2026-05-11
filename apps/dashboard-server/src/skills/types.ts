export interface SkillFrontmatter {
  name: string;
  description: string;
  model: 'opus' | 'sonnet' | 'haiku';
  'allowed-tools': string[];
  'argument-hint'?: string;
  'timeout-ms'?: number;
}

/**
 * Where a skill was discovered from. Used by the UI to label origins and
 * by the discovery layer to decide which copy wins on a name collision.
 *
 *   - 'seed'          built-in skill shipped with the harness
 *   - 'project'       <projectRoot>/.claude/skills/<name>/SKILL.md
 *   - 'user'          ~/.claude/skills/<name>/SKILL.md
 *   - `plugin:<name>` ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
 */
export type SkillSource = 'seed' | 'project' | 'user' | `plugin:${string}`;

export interface Skill {
  name: string;
  description: string;
  model: 'opus' | 'sonnet' | 'haiku';
  allowedTools: string[];
  argumentHint?: string;
  timeoutMs: number;
  systemPrompt: string; // body of SKILL.md after frontmatter
  filePath: string;
  /** Where this skill was discovered. Absent on tests that load a single file directly. */
  source?: SkillSource;
}
