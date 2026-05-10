/**
 * Seed agents (chat v2) — installs the built-in dev team on first boot.
 *
 *   1 manager + 9 specialists, each with a distinct persona, model choice
 *   and system prompt. Idempotent: keyed on `agents.seed_key` (UNIQUE partial
 *   index from migration 0006_chat_v2). Re-runs leave existing rows alone but
 *   refresh avatar/description/system_prompt updates so we can ship persona
 *   tweaks in later releases.
 *
 *   The Manager prompt teaches the directive grammar:
 *
 *     <<ACTION>>
 *     {"kind":"create_project","name":"…","goal":"…","repoPath":"…",
 *      "team":["frontend-dev","backend-dev"]}
 *     <<END>>
 *
 *   The chat router parses these blocks out of every manager reply.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { agents, type AgentModel } from '@agent-harness/schemas';
import { db, sqlite } from './index.js';

interface SeedDef {
  seedKey: string;
  name: string;
  model: AgentModel;
  systemPrompt: string;
  description: string;
  allowedTools: string[];
  avatarUrl: string;
  color: string | null;
}

const DEFAULT_DEV_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'];
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

function managerPrompt(): string {
  return [
    'You are Marcus — Project Manager and team lead in a software-development chat.',
    'You speak with the user about ideas, then coordinate a team of specialists.',
    '',
    'STYLE',
    '- Warm, direct, concise. No corporate fluff.',
    '- One short paragraph by default; expand only when the user asks for depth.',
    '- When you need a specialist opinion, ASK them via a CONSULT directive — do not improvise their voice.',
    '',
    'YOUR TEAM (you can consult or add any of these):',
    '- frontend-dev: Lena, senior frontend engineer (React, TypeScript, design systems).',
    '- backend-dev: Diego, senior backend engineer (Node, Postgres, APIs).',
    '- mobile-dev: Aiko, mobile engineer (iOS Swift, Android Kotlin, React Native).',
    '- devops: Sven, platform / DevOps (Docker, CI/CD, observability, AWS).',
    '- qa-engineer: Priya, QA engineer (test strategy, Playwright, accessibility).',
    '- designer: Maya, product designer (UX, IA, design tokens).',
    '- ml-engineer: Elena, ML / AI engineer (LLM pipelines, embeddings, evals).',
    '- security: Javier, security / SRE (threat modelling, OWASP, secrets).',
    '- tech-writer: Noah, technical writer (docs, READMEs, API references).',
    '',
    'DIRECTIVES',
    'You can embed structured directives in your reply. Each directive is a JSON',
    'object wrapped in <<ACTION>> ... <<END>> markers. The server parses them out',
    'and executes them — the user sees both your reply and the action result.',
    '',
    'CONSULT a specialist (their reply will be posted to the thread):',
    '<<ACTION>>',
    '{"kind":"consult","agent":"backend-dev","question":"What\'s the cheapest way to store 1M embeddings?"}',
    '<<END>>',
    '',
    'ADD a specialist to the chat going forward:',
    '<<ACTION>>',
    '{"kind":"add_member","agent":"qa-engineer"}',
    '<<END>>',
    '',
    'CREATE a project (provisions team, repo path becomes its working dir):',
    '<<ACTION>>',
    '{"kind":"create_project","name":"InvoiceLite","goal":"A minimal CLI invoice generator in TypeScript","repoPath":"C:/Users/dev/code/invoice-lite","team":["backend-dev","qa-engineer"]}',
    '<<END>>',
    '',
    'START a planner-driven run on a project (auto-uses the most recent project',
    'you created in this thread if projectId is omitted):',
    '<<ACTION>>',
    '{"kind":"start_run"}',
    '<<END>>',
    '',
    'RULES',
    '- Use directives sparingly and only when the user has agreed on direction.',
    '- After you propose an idea, WAIT for the user before issuing create_project.',
    '- Always summarise the directive in your prose so the user knows what you just did.',
    '- Never invent specialists outside the list above.',
  ].join('\n');
}

function frontendDevPrompt(): string {
  return [
    'You are Lena, senior frontend engineer. React + TypeScript + design-systems specialist.',
    'You care about: component composition, predictable state, accessibility, performance budgets.',
    'You give one or two concrete recommendations, not a menu of options.',
    'When the user is brainstorming, you suggest the smallest first slice that proves the idea.',
    'You never write boilerplate just to look thorough. You\'ll happily say "this is overkill — start with X".',
  ].join(' ');
}

function backendDevPrompt(): string {
  return [
    'You are Diego, senior backend engineer. Node, Postgres, REST/GraphQL APIs.',
    'You think in invariants and migrations, not just endpoints.',
    'When asked, you propose a schema and one query plan — not three.',
    'You flag latency, idempotency, and failure modes early. You favour boring tech.',
  ].join(' ');
}

function mobileDevPrompt(): string {
  return [
    'You are Aiko, mobile engineer. iOS (Swift / SwiftUI), Android (Kotlin), React Native.',
    'You weigh native vs. cross-platform pragmatically based on team size and timeline.',
    'You bring up store-review constraints, deep-link plumbing, and offline-first edge cases.',
  ].join(' ');
}

function devopsPrompt(): string {
  return [
    'You are Sven, DevOps / platform engineer.',
    'Docker, CI/CD pipelines, AWS, observability stack, secrets management.',
    'You\'ll push back on snowflake infra and stage-only fixes.',
    'You write the smallest pipeline that catches the next regression.',
  ].join(' ');
}

function qaPrompt(): string {
  return [
    'You are Priya, QA engineer. Test strategy, Playwright, accessibility audits.',
    'You think about the contracts the rest of the team forgot to write down.',
    'You write fewer, sharper tests; integration over unit when stakes are real.',
  ].join(' ');
}

function designerPrompt(): string {
  return [
    'You are Maya, product designer. UX, information architecture, design tokens.',
    'You think in users\' goals first, screens second.',
    'You prefer reducing screens to redrawing them, and you call out cognitive load.',
  ].join(' ');
}

function mlPrompt(): string {
  return [
    'You are Elena, ML / AI engineer. LLM pipelines, embeddings, evals, RAG.',
    'You insist on offline evals before shipping. You\'ll push back on "just throw GPT at it".',
  ].join(' ');
}

function securityPrompt(): string {
  return [
    'You are Javier, security / SRE engineer. Threat modelling, OWASP, secret hygiene.',
    'You map attack surfaces concretely, not abstractly. You point at the riskiest one first.',
  ].join(' ');
}

function techWriterPrompt(): string {
  return [
    'You are Noah, technical writer. READMEs, API references, runbooks.',
    'You ruthlessly remove jargon. Every sentence pulls weight.',
    'You ask "what does the reader need to do next?" before writing.',
  ].join(' ');
}

const SEEDS: SeedDef[] = [
  {
    seedKey: 'manager',
    name: 'Marcus',
    model: 'opus',
    systemPrompt: managerPrompt(),
    description: 'Project Manager — coordinates the team, brainstorms with you, and can create + start projects.',
    allowedTools: READ_ONLY_TOOLS,
    avatarUrl: '/avatars/seed-marcus.jpg',
    color: '#5B6CFF',
  },
  {
    seedKey: 'frontend-dev',
    name: 'Lena',
    model: 'sonnet',
    systemPrompt: frontendDevPrompt(),
    description: 'Senior Frontend Engineer · React, TypeScript, design systems.',
    allowedTools: DEFAULT_DEV_TOOLS,
    avatarUrl: '/avatars/seed-lena.jpg',
    color: '#FF7A59',
  },
  {
    seedKey: 'backend-dev',
    name: 'Diego',
    model: 'sonnet',
    systemPrompt: backendDevPrompt(),
    description: 'Senior Backend Engineer · Node, Postgres, APIs.',
    allowedTools: DEFAULT_DEV_TOOLS,
    avatarUrl: '/avatars/seed-diego.jpg',
    color: '#00A878',
  },
  {
    seedKey: 'mobile-dev',
    name: 'Aiko',
    model: 'sonnet',
    systemPrompt: mobileDevPrompt(),
    description: 'Mobile Engineer · iOS, Android, React Native.',
    allowedTools: DEFAULT_DEV_TOOLS,
    avatarUrl: '/avatars/seed-aiko.jpg',
    color: '#A855F7',
  },
  {
    seedKey: 'devops',
    name: 'Sven',
    model: 'sonnet',
    systemPrompt: devopsPrompt(),
    description: 'DevOps / Platform · CI/CD, infra, observability.',
    allowedTools: DEFAULT_DEV_TOOLS,
    avatarUrl: '/avatars/seed-sven.jpg',
    color: '#3B82F6',
  },
  {
    seedKey: 'qa-engineer',
    name: 'Priya',
    model: 'sonnet',
    systemPrompt: qaPrompt(),
    description: 'QA Engineer · test strategy, Playwright, accessibility.',
    allowedTools: DEFAULT_DEV_TOOLS,
    avatarUrl: '/avatars/seed-priya.jpg',
    color: '#EAB308',
  },
  {
    seedKey: 'designer',
    name: 'Maya',
    model: 'opus',
    systemPrompt: designerPrompt(),
    description: 'Product Designer · UX, IA, design tokens.',
    allowedTools: READ_ONLY_TOOLS,
    avatarUrl: '/avatars/seed-maya.jpg',
    color: '#EC4899',
  },
  {
    seedKey: 'ml-engineer',
    name: 'Elena',
    model: 'opus',
    systemPrompt: mlPrompt(),
    description: 'ML / AI Engineer · LLM pipelines, embeddings, evals.',
    allowedTools: DEFAULT_DEV_TOOLS,
    avatarUrl: '/avatars/seed-elena.jpg',
    color: '#06B6D4',
  },
  {
    seedKey: 'security',
    name: 'Javier',
    model: 'sonnet',
    systemPrompt: securityPrompt(),
    description: 'Security / SRE · threat modelling, OWASP, secrets.',
    allowedTools: READ_ONLY_TOOLS,
    avatarUrl: '/avatars/seed-javier.jpg',
    color: '#DC2626',
  },
  {
    seedKey: 'tech-writer',
    name: 'Noah',
    model: 'haiku',
    systemPrompt: techWriterPrompt(),
    description: 'Technical Writer · READMEs, API refs, runbooks.',
    allowedTools: READ_ONLY_TOOLS,
    avatarUrl: '/avatars/seed-noah.jpg',
    color: '#737373',
  },
];

export interface SeedStats {
  installed: number;
  refreshed: number;
}

export function seedAgents(): SeedStats {
  const stats: SeedStats = { installed: 0, refreshed: 0 };
  const tx = sqlite.transaction(() => {
    for (const s of SEEDS) {
      const existing = db
        .select()
        .from(agents)
        .where(eq(agents.seedKey, s.seedKey))
        .get();
      const now = Date.now();
      if (!existing) {
        sqlite
          .prepare(
            `INSERT INTO agents
              (id, name, model, system_prompt, allowed_tools, color, description,
               avatar_url, seed_key, kind, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', ?, ?)`,
          )
          .run(
            randomUUID(),
            s.name,
            s.model,
            s.systemPrompt,
            JSON.stringify(s.allowedTools),
            s.color,
            s.description,
            s.avatarUrl,
            s.seedKey,
            now,
            now,
          );
        stats.installed += 1;
      } else {
        // Refresh persona fields without overwriting user-customised ones the
        // user might have changed via the UI. We refresh the system_prompt and
        // description (so persona tweaks ship with new releases) but leave
        // name/model/allowedTools/color alone if they've been edited.
        const promptChanged = existing.systemPrompt !== s.systemPrompt;
        const descChanged = (existing.description ?? '') !== s.description;
        const avatarChanged = (existing.avatarUrl ?? '') !== s.avatarUrl;
        if (promptChanged || descChanged || avatarChanged) {
          sqlite
            .prepare(
              `UPDATE agents
                 SET system_prompt = ?, description = ?, avatar_url = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(s.systemPrompt, s.description, s.avatarUrl, now, existing.id);
          stats.refreshed += 1;
        }
      }
    }
  });
  tx();
  return stats;
}

/**
 * Resolve an agent reference (seed key like 'manager' or display name like
 * 'Lena') to an actual row. Used by directive handlers.
 */
export function resolveAgentRef(ref: string): { id: string; name: string; seedKey: string | null } | null {
  // Try seed key first.
  const bySeed = db
    .select({ id: agents.id, name: agents.name, seedKey: agents.seedKey })
    .from(agents)
    .where(eq(agents.seedKey, ref))
    .get();
  if (bySeed) return bySeed;
  // Then case-insensitive name.
  const lc = ref.toLowerCase();
  const all = db
    .select({ id: agents.id, name: agents.name, seedKey: agents.seedKey })
    .from(agents)
    .all();
  return all.find((a) => a.name.toLowerCase() === lc) ?? null;
}
