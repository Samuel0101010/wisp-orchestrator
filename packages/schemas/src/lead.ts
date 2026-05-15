import { z } from 'zod';

/**
 * Schema + parser for the lead agent's structured decision block.
 *
 * The lead (Theo) writes a short markdown narrative followed by exactly
 * one directive of the form:
 *
 *   <<LEAD_DECISION>>
 *   {"nextRole":"developer","reasoning":"...","blockers":["..."],
 *    "recommendedAction":"continue"}
 *   <<END>>
 *
 * Mirrors `brief.ts` (briefPatchSchema + parseBriefPatchFromText) but emits
 * a routing decision rather than a brief patch. All fields are optional so
 * a tick on a brand-new empty project can still produce a valid (mostly
 * empty) decision — typically with `recommendedAction: 'wait-for-user'`.
 */
export const leadDecisionSchema = z
  .object({
    nextRole: z.string().trim().min(1).max(200).nullable().optional(),
    reasoning: z.string().trim().min(1).max(4000).nullable().optional(),
    blockers: z.array(z.string().trim().min(1).max(1000)).max(20).optional(),
    recommendedAction: z.enum(['continue', 'replan', 'wait-for-user']).optional(),
  })
  .strict();

export type LeadDecision = z.infer<typeof leadDecisionSchema>;

const DECISION_OPEN = '<<LEAD_DECISION>>';
const DECISION_CLOSE = '<<END>>';

/**
 * Pulls the first `<<LEAD_DECISION>>{...}<<END>>` block out of an agent
 * reply, parses + validates the JSON inside.
 *
 * Tolerant of:
 *   - leading/trailing whitespace inside the block
 *   - extra prose surrounding the directive
 *   - missing block (returns `decision: null`, no error)
 *   - invalid JSON or unknown fields (returns `parseError`, decision stays null)
 *
 * Returns the cleaned reply text (directive stripped) so the route can
 * persist a clean markdown summary and the UI doesn't render raw markers.
 */
export function parseLeadDecisionFromText(text: string): {
  cleanedText: string;
  decision: LeadDecision | null;
  parseError: string | null;
} {
  let parseError: string | null = null;
  let decision: LeadDecision | null = null;
  let working = text;

  const open = working.indexOf(DECISION_OPEN);
  if (open !== -1) {
    const close = working.indexOf(DECISION_CLOSE, open + DECISION_OPEN.length);
    if (close === -1) {
      parseError = 'unterminated_lead_decision_block';
    } else {
      const body = working.slice(open + DECISION_OPEN.length, close).trim();
      try {
        const parsed = JSON.parse(body);
        const result = leadDecisionSchema.safeParse(parsed);
        if (result.success) {
          decision = result.data;
        } else {
          parseError =
            'invalid_lead_decision: ' +
            result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        }
      } catch (err) {
        parseError =
          'invalid_lead_decision_json: ' + (err instanceof Error ? err.message : 'unknown');
      }
      working = working.slice(0, open) + working.slice(close + DECISION_CLOSE.length);
    }
  }

  const cleanedText = working.replace(/\n{3,}/g, '\n\n').trim();
  return { cleanedText, decision, parseError };
}
