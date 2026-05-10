import { randomUUID } from 'node:crypto';
import { runAgentTurn, type RunAgentTurnResult } from '../routes/chat-engine.js';
import type { SubprocessRunner } from '@agent-harness/orchestrator';
import type { SkillRegistry } from './registry.js';

export interface InvokeSkillOpts {
  registry: SkillRegistry;
  name: string;
  args: string;
  runner?: SubprocessRunner;
}

export type InvokeSkillResult = RunAgentTurnResult & { skillName: string };

export async function invokeSkill(opts: InvokeSkillOpts): Promise<InvokeSkillResult> {
  const skill = opts.registry.get(opts.name);
  if (!skill) {
    return {
      text: '', tokensIn: 0, tokensOut: 0, durationMs: 0,
      failed: 'skill_not_found', skillName: opts.name,
    };
  }
  const result = await runAgentTurn({
    systemPrompt: skill.systemPrompt,
    prompt: opts.args,
    allowedTools: skill.allowedTools,
    model: skill.model,
    taskId: `skill-${skill.name}-${randomUUID().slice(0, 8)}`,
    runner: opts.runner,
    timeoutMs: skill.timeoutMs,
  });
  return { ...result, skillName: skill.name };
}
