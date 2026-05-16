import { randomUUID } from 'node:crypto';
import { runAgentTurn, type RunAgentTurnResult } from '../routes/chat-engine.js';
import type { SubprocessRunner } from '@wisp/orchestrator';
import type { SkillRegistry } from './registry.js';
import { buildBundleKey, lookupBundle, upsertBundle } from '../cache/prompt-bundle.js';

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
      text: '',
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
      failed: 'skill_not_found',
      skillName: opts.name,
    };
  }

  const bundleKey = buildBundleKey({
    systemPrompt: skill.systemPrompt,
    allowedTools: skill.allowedTools,
    model: skill.model,
  });
  const existing = lookupBundle(bundleKey);
  let cwd: string;
  let resumeSessionId: string | undefined;
  if (existing) {
    cwd = existing.cwd;
    resumeSessionId = existing.claudeSessionId ?? undefined;
  } else {
    const upserted = await upsertBundle(bundleKey, {
      systemPrompt: skill.systemPrompt,
      allowedTools: skill.allowedTools,
      model: skill.model,
    });
    cwd = upserted.cwd;
  }

  const result = await runAgentTurn({
    systemPrompt: skill.systemPrompt,
    prompt: opts.args,
    allowedTools: skill.allowedTools,
    model: skill.model,
    taskId: `skill-${skill.name}-${randomUUID().slice(0, 8)}`,
    runner: opts.runner,
    timeoutMs: skill.timeoutMs,
    cwd,
    resumeSessionId,
    bundleKey,
  });
  return { ...result, skillName: skill.name };
}
