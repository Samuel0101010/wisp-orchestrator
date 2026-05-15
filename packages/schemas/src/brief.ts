import { z } from 'zod';

/**
 * Schema for the structured patch the requirements-interviewer agent emits
 * after every user reply. The agent writes:
 *
 *   ...prose answer / next question...
 *
 *   <<BRIEF_PATCH>>
 *   {"targetAudience":"...", "completenessScore": 60}
 *   <<END>>
 *
 *   (optional) <<BRIEF_COMPLETE>>
 *
 * The interview engine extracts the JSON between BRIEF_PATCH/END, validates it
 * against this schema, and merges non-null fields into the project_briefs row.
 *
 * All fields are optional because the agent may only refine ONE field per
 * turn. `completenessScore` is the agent's self-estimate (0–100) — the engine
 * clamps to [0, 100] and never lets it regress (max(prev, new)).
 */
export const briefPatchSchema = z
  .object({
    targetAudience: z.string().trim().min(1).max(2000).nullable().optional(),
    successCriteria: z.string().trim().min(1).max(4000).nullable().optional(),
    designPrefs: z.string().trim().min(1).max(4000).nullable().optional(),
    platform: z.string().trim().min(1).max(500).nullable().optional(),
    constraints: z.string().trim().min(1).max(4000).nullable().optional(),
    /** Unix ms; agent emits as integer. NULL clears a previously-set deadline. */
    deadline: z.number().int().nonnegative().nullable().optional(),
    completenessScore: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export type BriefPatch = z.infer<typeof briefPatchSchema>;

const PATCH_OPEN = '<<BRIEF_PATCH>>';
const PATCH_CLOSE = '<<END>>';
const COMPLETE_MARKER = '<<BRIEF_COMPLETE>>';

/**
 * Pulls the first `<<BRIEF_PATCH>>{...}<<END>>` block out of an agent reply,
 * parses + validates the JSON inside, and detects whether the agent appended
 * `<<BRIEF_COMPLETE>>`.
 *
 * Tolerant of:
 *   - leading/trailing whitespace inside the block
 *   - extra prose surrounding the directives
 *   - missing block (returns `patch: null`)
 *   - invalid JSON (returns `parseError`, patch stays null)
 *
 * Returns the cleaned reply text (directives stripped) so the route can
 * persist a clean assistant message and the UI doesn't render the raw
 * machine markers.
 */
export function parseBriefPatchFromText(text: string): {
  cleanedText: string;
  patch: BriefPatch | null;
  complete: boolean;
  parseError: string | null;
} {
  let parseError: string | null = null;
  let patch: BriefPatch | null = null;
  let working = text;

  const open = working.indexOf(PATCH_OPEN);
  if (open !== -1) {
    const close = working.indexOf(PATCH_CLOSE, open + PATCH_OPEN.length);
    if (close === -1) {
      parseError = 'unterminated_brief_patch_block';
    } else {
      const body = working.slice(open + PATCH_OPEN.length, close).trim();
      try {
        const parsed = JSON.parse(body);
        const result = briefPatchSchema.safeParse(parsed);
        if (result.success) {
          patch = result.data;
        } else {
          parseError =
            'invalid_brief_patch: ' +
            result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        }
      } catch (err) {
        parseError =
          'invalid_brief_patch_json: ' + (err instanceof Error ? err.message : 'unknown');
      }
      working = working.slice(0, open) + working.slice(close + PATCH_CLOSE.length);
    }
  }

  let complete = false;
  const completeIdx = working.indexOf(COMPLETE_MARKER);
  if (completeIdx !== -1) {
    complete = true;
    working = working.slice(0, completeIdx) + working.slice(completeIdx + COMPLETE_MARKER.length);
  }

  const cleanedText = working.replace(/\n{3,}/g, '\n\n').trim();
  return { cleanedText, patch, complete, parseError };
}
