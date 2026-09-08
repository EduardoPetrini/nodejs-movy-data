import { describe, it, expect } from 'vitest';
import { slugify, isValidSlug, RESERVED_SLUGS } from '#shared/org-slug';

describe('slugify', () => {
  it('lowercases and hyphenates a display name', () => {
    expect(slugify('Acme Corp')).toBe('acme-corp');
  });

  it('folds diacritics rather than dropping the letters', () => {
    // 'Ácme' losing its first letter would silently produce a different org.
    expect(slugify('Ácme Ltda')).toBe('acme-ltda');
  });

  it('collapses runs of punctuation into a single separator', () => {
    expect(slugify('Data  //  Platform!!')).toBe('data-platform');
  });

  it('trims leading and trailing separators', () => {
    expect(slugify('  -- Acme -- ')).toBe('acme');
  });

  it('caps length so a slug stays a usable URL segment', () => {
    expect(slugify('x'.repeat(80))).toHaveLength(40);
  });

  it('returns empty for a name with nothing slug-worthy in it', () => {
    expect(slugify('!!! ???')).toBe('');
  });
});

describe('isValidSlug', () => {
  it('accepts lowercase alphanumeric words joined by single hyphens', () => {
    expect(isValidSlug('acme')).toBe(true);
    expect(isValidSlug('acme-corp-2')).toBe(true);
  });

  it('rejects anything that is not already normalised', () => {
    for (const bad of ['', 'a', 'Acme', 'acme corp', '-acme', 'acme-', 'acme--corp', 'acme_corp', 'x'.repeat(41)]) {
      expect(isValidSlug(bad), bad).toBe(false);
    }
  });

  it('rejects slugs that would collide with an application route', () => {
    // /orgs/new and /api/orgs both exist; an org that owned one of those
    // words would be unreachable at best and shadowing at worst.
    for (const reserved of RESERVED_SLUGS) expect(isValidSlug(reserved), reserved).toBe(false);
  });
});
