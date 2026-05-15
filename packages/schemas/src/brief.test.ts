import { describe, it, expect } from 'vitest';
import { briefPatchSchema, parseBriefPatchFromText } from './brief.js';

describe('briefPatchSchema', () => {
  it('accepts a minimal patch with just completenessScore', () => {
    const r = briefPatchSchema.safeParse({ completenessScore: 40 });
    expect(r.success).toBe(true);
  });

  it('accepts a full patch', () => {
    const r = briefPatchSchema.safeParse({
      targetAudience: 'developers',
      successCriteria: 'p99 < 200ms',
      designPrefs: 'minimal',
      platform: 'web',
      constraints: 'no third-party deps',
      deadline: 1799900000000,
      completenessScore: 90,
    });
    expect(r.success).toBe(true);
  });

  it('rejects out-of-range completenessScore', () => {
    expect(briefPatchSchema.safeParse({ completenessScore: 150 }).success).toBe(false);
    expect(briefPatchSchema.safeParse({ completenessScore: -1 }).success).toBe(false);
  });

  it('rejects unknown fields (strict mode catches typos)', () => {
    const r = briefPatchSchema.safeParse({ targt_audience: 'developers' });
    expect(r.success).toBe(false);
  });

  it('allows null to clear a field', () => {
    const r = briefPatchSchema.safeParse({ deadline: null });
    expect(r.success).toBe(true);
  });
});

describe('parseBriefPatchFromText', () => {
  it('returns null patch and no error when no block present', () => {
    const r = parseBriefPatchFromText('Hello, what platform are you targeting?');
    expect(r.patch).toBeNull();
    expect(r.complete).toBe(false);
    expect(r.parseError).toBeNull();
    expect(r.cleanedText).toBe('Hello, what platform are you targeting?');
  });

  it('extracts a valid patch and strips the block from cleaned text', () => {
    const reply = [
      'Great. Next question: what is the target audience?',
      '',
      '<<BRIEF_PATCH>>',
      '{"platform":"web","completenessScore":35}',
      '<<END>>',
    ].join('\n');
    const r = parseBriefPatchFromText(reply);
    expect(r.patch).toEqual({ platform: 'web', completenessScore: 35 });
    expect(r.complete).toBe(false);
    expect(r.parseError).toBeNull();
    expect(r.cleanedText).toContain('Great. Next question');
    expect(r.cleanedText).not.toContain('BRIEF_PATCH');
    expect(r.cleanedText).not.toContain('"platform"');
  });

  it('detects BRIEF_COMPLETE marker and strips it', () => {
    const reply = [
      'I now have everything I need.',
      '<<BRIEF_PATCH>>',
      '{"completenessScore":95}',
      '<<END>>',
      '<<BRIEF_COMPLETE>>',
    ].join('\n');
    const r = parseBriefPatchFromText(reply);
    expect(r.complete).toBe(true);
    expect(r.patch).toEqual({ completenessScore: 95 });
    expect(r.cleanedText).not.toContain('BRIEF_COMPLETE');
    expect(r.cleanedText).toContain('I now have everything I need.');
  });

  it('reports parse error on invalid JSON without crashing', () => {
    const reply = 'Hello.\n<<BRIEF_PATCH>>\n{not json}\n<<END>>';
    const r = parseBriefPatchFromText(reply);
    expect(r.patch).toBeNull();
    expect(r.parseError).toMatch(/invalid_brief_patch_json/);
    expect(r.cleanedText).toBe('Hello.');
  });

  it('reports schema error on unknown fields', () => {
    const reply = 'Hi.\n<<BRIEF_PATCH>>\n{"bogus":"x"}\n<<END>>';
    const r = parseBriefPatchFromText(reply);
    expect(r.patch).toBeNull();
    expect(r.parseError).toMatch(/invalid_brief_patch:/);
  });

  it('handles unterminated block gracefully', () => {
    const reply = 'Hi.\n<<BRIEF_PATCH>>\n{"platform":"web"';
    const r = parseBriefPatchFromText(reply);
    expect(r.patch).toBeNull();
    expect(r.parseError).toBe('unterminated_brief_patch_block');
  });
});
