export interface SkillFrontmatter {
  name: string;
  description: string;
  model: 'opus' | 'sonnet' | 'haiku';
  'allowed-tools': string[];
  'argument-hint'?: string;
  'timeout-ms'?: number;
}

export interface Skill {
  name: string;
  description: string;
  model: 'opus' | 'sonnet' | 'haiku';
  allowedTools: string[];
  argumentHint?: string;
  timeoutMs: number;
  systemPrompt: string;  // body of SKILL.md after frontmatter
  filePath: string;
}
