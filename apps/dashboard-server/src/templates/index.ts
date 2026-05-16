import { z } from 'zod';
import { teamSchema, type Team } from '@wisp/schemas';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

function readJson(filename: string): unknown {
  return JSON.parse(readFileSync(path.join(here, filename), 'utf8')) as unknown;
}

const tsLibraryRaw = readJson('ts-library.json');
const pythonBackendRaw = readJson('python-backend.json');
const refactorSquadRaw = readJson('refactor-squad.json');
const dataPipelineRaw = readJson('data-pipeline.json');

export const templateSchema = z.object({
  id: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/, {
      message: 'template id must be kebab-case starting with a letter',
    }),
  name: z.string().min(2).max(80),
  description: z.string().min(20).max(400),
  team: teamSchema,
  suggestedGoals: z.array(z.string().min(10).max(400)).min(1).max(8),
  // Rich descriptive metadata, optional for backward compatibility with
  // user-saved templates that pre-date these fields.
  useCases: z.array(z.string().min(5).max(200)).max(8).optional(),
  bestFor: z.array(z.string().min(3).max(120)).max(6).optional(),
  notRecommendedFor: z.array(z.string().min(3).max(120)).max(6).optional(),
  complexity: z.enum(['simple', 'medium', 'complex']).optional(),
  expectedDurationMinutes: z.number().int().min(1).max(360).optional(),
});

export type TeamTemplate = z.infer<typeof templateSchema>;

const RAW_BUILT_INS = [tsLibraryRaw, pythonBackendRaw, refactorSquadRaw, dataPipelineRaw] as const;

/**
 * Validate every built-in at module load. If a template drifts away from the
 * schema (e.g. teamSchema gets stricter), the server fails to boot — much
 * better than a runtime 500 on first GET.
 */
function loadBuiltInTemplates(): TeamTemplate[] {
  const out: TeamTemplate[] = [];
  for (const raw of RAW_BUILT_INS) {
    const result = templateSchema.safeParse(raw);
    if (!result.success) {
      const id = (raw as { id?: string }).id ?? '<unknown>';
      throw new Error(`Built-in template '${id}' failed validation:\n${result.error.toString()}`);
    }
    out.push(result.data);
  }
  // Detect duplicate ids across built-ins.
  const ids = new Set<string>();
  for (const t of out) {
    if (ids.has(t.id)) throw new Error(`duplicate built-in template id: ${t.id}`);
    ids.add(t.id);
  }
  return out;
}

export const builtInTemplates: readonly TeamTemplate[] = loadBuiltInTemplates();

export type { Team };
