import { describe, it, expect } from 'vitest';
import {
  MAX_PREFIX_LENGTH,
  MAX_TOKENS,
  buildSearchTokens,
  normaliseSearchText,
  prefixesOf,
  rankMatches,
  toSearchToken,
  tokenise,
} from './search';

describe('normaliseSearchText()', () => {
  it('lowercases and trims', () => {
    expect(normaliseSearchText('  Fatima  ')).toBe('fatima');
  });

  it('strips Latin diacritics so accented names are reachable by plain typing', () => {
    expect(normaliseSearchText('José')).toBe('jose');
    expect(normaliseSearchText('Chloé')).toBe('chloe');
  });

  it('folds Arabic alef variants — staff will not type the hamza', () => {
    expect(normaliseSearchText('أحمد')).toBe(normaliseSearchText('احمد'));
    expect(normaliseSearchText('إيمان')).toBe(normaliseSearchText('ايمان'));
    expect(normaliseSearchText('آمنة')).toBe(normaliseSearchText('امنه'));
  });

  it('folds alef maqsura to yeh and teh marbuta to heh', () => {
    expect(normaliseSearchText('ليلى')).toBe(normaliseSearchText('ليلي'));
    expect(normaliseSearchText('فاطمة')).toBe(normaliseSearchText('فاطمه'));
  });

  it('removes Arabic diacritics and tatweel', () => {
    expect(normaliseSearchText('مُحَمَّد')).toBe(normaliseSearchText('محمد'));
    expect(normaliseSearchText('محـــمد')).toBe(normaliseSearchText('محمد'));
  });
});

describe('tokenise()', () => {
  it('splits on whitespace and punctuation', () => {
    expect(tokenise('Fatima Al-Balushi')).toEqual(['fatima', 'al', 'balushi']);
  });

  it('keeps digits as words', () => {
    expect(tokenise('WD-0001')).toEqual(['wd', '0001']);
  });

  it('handles Arabic text', () => {
    expect(tokenise('فاطمة البلوشي')).toEqual(['فاطمه', 'البلوشي']);
  });

  it('returns nothing for empty or punctuation-only input', () => {
    expect(tokenise('')).toEqual([]);
    expect(tokenise('   ')).toEqual([]);
    expect(tokenise('---')).toEqual([]);
  });
});

describe('prefixesOf()', () => {
  it('produces every prefix from two characters to the word length', () => {
    expect(prefixesOf('fatima')).toEqual(['fa', 'fat', 'fati', 'fatim', 'fatima']);
  });

  it('keeps a one-character word findable', () => {
    expect(prefixesOf('a')).toEqual(['a']);
  });

  it('caps long words so the token set stays bounded', () => {
    const prefixes = prefixesOf('supercalifragilistic');
    expect(prefixes[prefixes.length - 1]).toHaveLength(MAX_PREFIX_LENGTH);
  });

  it('returns nothing for an empty word', () => {
    expect(prefixesOf('')).toEqual([]);
  });
});

describe('buildSearchTokens()', () => {
  it('indexes every word of every field', () => {
    const tokens = buildSearchTokens(['Fatima Al Balushi', 'CU-0001']);

    expect(tokens).toContain('fa');
    expect(tokens).toContain('fatima');
    expect(tokens).toContain('ba');
    expect(tokens).toContain('balushi');
    expect(tokens).toContain('cu');
    expect(tokens).toContain('0001');
  });

  it('finds a customer by any word, not only the first', () => {
    // The failure a whole-word or start-anchored index would produce: typing a
    // surname and getting nothing.
    const tokens = buildSearchTokens(['Aisha Nadia Al Habsi']);
    expect(tokens).toContain('nadia');
    expect(tokens).toContain('hab');
  });

  it('indexes phone suffixes, because staff read the last digits off a screen', () => {
    const tokens = buildSearchTokens(['96891234567']);
    expect(tokens).toContain('4567');
    expect(tokens).toContain('1234567');
  });

  it('does not build suffixes for short digit runs', () => {
    const tokens = buildSearchTokens(['12']);
    expect(tokens).toEqual(['12']);
  });

  it('indexes Arabic names in their normalised form', () => {
    const tokens = buildSearchTokens(['فاطمة البلوشي']);
    // Typed without the teh marbuta, which is how staff will enter it.
    expect(tokens).toContain(normaliseSearchText('فاطمه'));
  });

  it('skips null, undefined and empty fields', () => {
    expect(buildSearchTokens([null, undefined, '', 'Ada'])).toEqual(['ad', 'ada']);
  });

  it('deduplicates tokens shared between fields', () => {
    const tokens = buildSearchTokens(['Fatima', 'Fatima']);
    expect(tokens).toEqual([...new Set(tokens)]);
  });

  it('is deterministic, so a rewrite with identical data produces no diff', () => {
    const a = buildSearchTokens(['Fatima Al Balushi', 'CU-0001']);
    const b = buildSearchTokens(['Fatima Al Balushi', 'CU-0001']);
    expect(a).toEqual(b);
  });

  it('caps the token count so a pathological record cannot bloat the document', () => {
    const absurd = Array.from({ length: 200 }, (_, index) => `word${index}`).join(' ');
    expect(buildSearchTokens([absurd]).length).toBeLessThanOrEqual(MAX_TOKENS);
  });

  it('returns nothing when there is nothing to index', () => {
    expect(buildSearchTokens([])).toEqual([]);
    expect(buildSearchTokens(['', '   '])).toEqual([]);
  });
});

describe('toSearchToken()', () => {
  it('returns a token that a stored record would contain', () => {
    const tokens = buildSearchTokens(['Fatima Al Balushi']);
    const token = toSearchToken('fatima');

    expect(token).not.toBeNull();
    expect(tokens).toContain(token);
  });

  it('picks the most selective word rather than the first', () => {
    // Querying "al" would return most of the collection.
    expect(toSearchToken('Al Balushi')).toBe('balushi');
  });

  it('truncates to the indexed prefix length so long queries still match', () => {
    const token = toSearchToken('supercalifragilistic');
    expect(token).toHaveLength(MAX_PREFIX_LENGTH);
    expect(buildSearchTokens(['supercalifragilistic'])).toContain(token);
  });

  it('normalises the query the same way as the index', () => {
    const tokens = buildSearchTokens(['أحمد']);
    expect(tokens).toContain(toSearchToken('احمد'));
  });

  it('returns null when there is nothing searchable', () => {
    expect(toSearchToken('')).toBeNull();
    expect(toSearchToken('   ')).toBeNull();
    expect(toSearchToken('!!!')).toBeNull();
  });
});

describe('rankMatches()', () => {
  const people = [
    { name: 'Fatima Al Balushi' },
    { name: 'Al Habsi Trading' },
    { name: 'Fatima Said' },
    { name: 'Noor Al Balushi' },
  ];

  const text = (person: { name: string }) => person.name;

  it('keeps only records matching every word typed', () => {
    const results = rankMatches('fatima balushi', people, text);
    expect(results).toEqual([{ name: 'Fatima Al Balushi' }]);
  });

  it('ranks exact word matches above prefix matches', () => {
    const results = rankMatches('fatima', people, text);
    expect(results[0]).toEqual({ name: 'Fatima Al Balushi' });
    expect(results).toHaveLength(2);
  });

  it('matches on a prefix', () => {
    const results = rankMatches('fat', people, text);
    expect(results).toHaveLength(2);
  });

  it('returns everything when the query has no searchable words', () => {
    expect(rankMatches('', people, text)).toHaveLength(people.length);
  });

  it('returns nothing when no record matches', () => {
    expect(rankMatches('zzzz', people, text)).toEqual([]);
  });

  it('matches a digit query against the middle or end of a longer number', () => {
    /*
     * The index emits suffix tokens for digit runs, so a query for the last four
     * digits of a phone number finds the record. Ranking must accept the same
     * matches, or the query returns a candidate that is then filtered out here.
     */
    const customers = [{ name: 'Maryam CU-0008 96893330007' }];

    expect(rankMatches('0007', customers, text)).toHaveLength(1);
    expect(rankMatches('3330007', customers, text)).toHaveLength(1);
  });

  it('does not let a digit substring match unrelated text', () => {
    const customers = [{ name: 'Fatima 96891234567' }];
    expect(rankMatches('9999', customers, text)).toEqual([]);
  });
});
