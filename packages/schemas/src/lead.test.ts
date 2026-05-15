import { describe, expect, it } from 'vitest';
import { parseLeadDecisionFromText, leadDecisionSchema } from './lead.js';

describe('parseLeadDecisionFromText', () => {
  it('returns no decision and no error for empty/plain text', () => {
    const r = parseLeadDecisionFromText('Hello, no directive here.');
    expect(r.decision).toBeNull();
    expect(r.parseError).toBeNull();
    expect(r.cleanedText).toBe('Hello, no directive here.');
  });

  it('parses a valid directive and strips it from the cleaned text', () => {
    const txt = [
      'The team is making solid progress on the auth feature.',
      '',
      '<<LEAD_DECISION>>',
      '{"nextRole":"developer","reasoning":"Push login UI","blockers":[],"recommendedAction":"continue"}',
      '<<END>>',
    ].join('\n');
    const r = parseLeadDecisionFromText(txt);
    expect(r.parseError).toBeNull();
    expect(r.decision).toMatchObject({
      nextRole: 'developer',
      reasoning: 'Push login UI',
      recommendedAction: 'continue',
    });
    expect(r.decision?.blockers).toEqual([]);
    expect(r.cleanedText).toContain('solid progress');
    expect(r.cleanedText).not.toContain('LEAD_DECISION');
    expect(r.cleanedText).not.toContain('<<END>>');
  });

  it('reports parseError for invalid JSON, keeps decision null', () => {
    const txt = '<<LEAD_DECISION>>\n{not json,}\n<<END>>';
    const r = parseLeadDecisionFromText(txt);
    expect(r.decision).toBeNull();
    expect(r.parseError).toMatch(/invalid_lead_decision_json/);
  });

  it('rejects unknown fields under strict mode', () => {
    const txt = '<<LEAD_DECISION>>\n{"nextRole":"developer","wat":"unknown"}\n<<END>>';
    const r = parseLeadDecisionFromText(txt);
    expect(r.decision).toBeNull();
    expect(r.parseError).toMatch(/invalid_lead_decision/);
  });

  it('reports parseError for invalid recommendedAction enum', () => {
    const txt = '<<LEAD_DECISION>>\n{"recommendedAction":"explode"}\n<<END>>';
    const r = parseLeadDecisionFromText(txt);
    expect(r.decision).toBeNull();
    expect(r.parseError).toMatch(/invalid_lead_decision/);
  });

  it('reports parseError on unterminated directive', () => {
    const txt = 'narrative...\n<<LEAD_DECISION>>\n{"nextRole":"developer"}';
    const r = parseLeadDecisionFromText(txt);
    expect(r.decision).toBeNull();
    expect(r.parseError).toBe('unterminated_lead_decision_block');
  });

  it('round-trips multi-paragraph narrative + decision', () => {
    const narrative = [
      'Paragraph one — what is working.',
      '',
      'Paragraph two — what is stuck.',
      '',
      'Paragraph three — recommendation.',
    ].join('\n');
    const txt = `${narrative}\n\n<<LEAD_DECISION>>\n{"nextRole":null,"recommendedAction":"wait-for-user","blockers":["brief not finalised"]}\n<<END>>\n`;
    const r = parseLeadDecisionFromText(txt);
    expect(r.parseError).toBeNull();
    expect(r.decision?.recommendedAction).toBe('wait-for-user');
    expect(r.decision?.blockers).toEqual(['brief not finalised']);
    expect(r.decision?.nextRole).toBeNull();
    expect(r.cleanedText).toContain('Paragraph one');
    expect(r.cleanedText).toContain('Paragraph three');
    expect(r.cleanedText).not.toMatch(/<<LEAD_DECISION>>|<<END>>/);
  });

  it('schema accepts a minimal decision (only recommendedAction)', () => {
    const r = leadDecisionSchema.safeParse({ recommendedAction: 'replan' });
    expect(r.success).toBe(true);
  });
});
