import { describe, expect, it } from 'vitest';
import { defaultRepoPath, slugifyProjectName } from './default-repo-path';

describe('slugifyProjectName', () => {
  it('lowercases and folds German umlauts + ß', () => {
    expect(slugifyProjectName('Zitat Des Tages')).toBe('zitat-des-tages');
    expect(slugifyProjectName('Übungs-App für Größe')).toBe('uebungs-app-fuer-groesse');
    expect(slugifyProjectName('Ärzte Börse')).toBe('aerzte-boerse');
  });

  it('transliterates accented chars instead of dropping them', () => {
    expect(slugifyProjectName('Mein Café Plan')).toBe('mein-cafe-plan');
    expect(slugifyProjectName('À la carte')).toBe('a-la-carte');
    // Umlaut folding still wins over the NFD strip: ä→ae, not a.
    expect(slugifyProjectName('ä')).toBe('ae');
  });

  it('collapses runs of disallowed chars into a single dash and trims', () => {
    expect(slugifyProjectName('  My  $$ App!! ')).toBe('my-app');
    expect(slugifyProjectName('---hello---')).toBe('hello');
  });

  it('falls back to wisp-app for empty or fully-stripped names', () => {
    expect(slugifyProjectName('')).toBe('wisp-app');
    expect(slugifyProjectName('   ')).toBe('wisp-app');
    expect(slugifyProjectName('!!!')).toBe('wisp-app');
  });

  it('caps the slug at 40 chars without a trailing dash', () => {
    const long = 'a'.repeat(50);
    expect(slugifyProjectName(long)).toBe('a'.repeat(40));
    // A name whose 40-char cut lands right after a dash must not keep it.
    const dashAt40 = `${'b'.repeat(39)}-tail`;
    expect(slugifyProjectName(dashAt40)).toBe('b'.repeat(39));
  });
});

describe('defaultRepoPath', () => {
  it('joins base + slug with the given separator', () => {
    expect(defaultRepoPath('/home/sam/wisp', '/', 'My App')).toBe('/home/sam/wisp/my-app');
  });

  it('supports Windows backslash separators', () => {
    expect(defaultRepoPath('C:\\Users\\sam\\wisp', '\\', 'Zitat des Tages')).toBe(
      'C:\\Users\\sam\\wisp\\zitat-des-tages',
    );
  });

  it('does not double the separator when base already ends with it', () => {
    expect(defaultRepoPath('/home/sam/wisp/', '/', 'My App')).toBe('/home/sam/wisp/my-app');
    expect(defaultRepoPath('C:\\wisp\\', '\\', 'App')).toBe('C:\\wisp\\app');
  });

  it('uses the wisp-app fallback for an empty name', () => {
    expect(defaultRepoPath('/base', '/', '')).toBe('/base/wisp-app');
  });
});
