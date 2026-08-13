/**
 * Search token generation.
 *
 * Firestore has no full-text search. The strategy here is to materialise, on
 * every write, the set of prefixes an employee would plausibly type, and query
 * them with `array-contains`. One indexed equality on an array field returns
 * matches in a single round trip and reads only the matching documents — the
 * specification's constraint is that search must never pull the whole customer
 * database into the browser.
 *
 * Why prefixes rather than whole words: staff type `fat` and expect Fatima, or
 * the first four digits of a phone number. Whole-word tokens would require an
 * exact match and fail that.
 *
 * Why not `>=`/`<=` range queries: a range only matches from the start of a
 * single field, so `nadia` would not find "Aisha Nadia", and searching several
 * fields would need one query per field per term. `array-contains` covers every
 * word of every field with one query.
 *
 * Arabic is tokenised the same way. Arabic script is not case-sensitive, but
 * normalising alef and yeh variants matters: staff type `احمد` and the record
 * may hold `أحمد`.
 *
 * Pure: no I/O, no Firebase, no clock.
 */

/**
 * Shortest prefix stored. One-character prefixes would match a large share of
 * the collection and make the index expensive without helping anyone.
 */
export const MIN_PREFIX_LENGTH = 2;

/**
 * Longest prefix stored. Beyond this the token set grows without improving
 * matching: a query longer than the cap is truncated to it, and the small number
 * of candidates returned is then filtered exactly in memory.
 */
export const MAX_PREFIX_LENGTH = 12;

/** Guards pathological input from unbounded document growth. */
export const MAX_TOKENS = 200;

/**
 * Normalise text for indexing and querying.
 *
 * Both sides use this, so a query normalised differently from the stored token
 * could never match.
 */
export function normaliseSearchText(input: string): string {
  return (
    input
      .toLowerCase()

      /*
       * Arabic is folded FIRST, on the composed form.
       *
       * Unicode normalisation decomposes أ (U+0623) into ا plus a combining
       * hamza, so folding after normalising would never match the composed
       * character — and the stray combining mark would then split the word in
       * two during tokenisation. Order matters here, and getting it wrong makes
       * Arabic search silently return nothing.
       */
      .replace(/ـ/g, '') // tatweel (kashida)
      .replace(/[ً-ٰٕ]/g, '') // harakat and hamza marks
      .replace(/[أإآٱ]/g, 'ا') // أ إ آ ٱ → ا
      .replace(/ى/g, 'ي') // ى → ي
      .replace(/ة/g, 'ه') // ة → ه

      // Latin diacritics, so "José" is reachable by typing "jose".
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')

      .trim()
  );
}

/** Split normalised text into words, discarding punctuation. */
export function tokenise(input: string): string[] {
  const normalised = normaliseSearchText(input);
  if (normalised.length === 0) return [];

  return normalised.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
}

/**
 * Every prefix of `word` between the minimum and maximum lengths.
 *
 * A word shorter than the minimum still yields itself, so a two-letter name or
 * a short code remains findable.
 */
export function prefixesOf(word: string): string[] {
  if (word.length === 0) return [];

  const upper = Math.min(word.length, MAX_PREFIX_LENGTH);

  if (word.length < MIN_PREFIX_LENGTH) {
    return [word];
  }

  const prefixes: string[] = [];
  for (let length = MIN_PREFIX_LENGTH; length <= upper; length += 1) {
    prefixes.push(word.slice(0, length));
  }
  return prefixes;
}

/**
 * Build the `searchTokens` array for a record.
 *
 * Pass every field an employee might search by. Numbers are handled specially:
 * a phone number is also indexed by its trailing digits, because staff read the
 * last four off a screen far more often than they type the whole thing.
 */
export function buildSearchTokens(fields: readonly (string | null | undefined)[]): string[] {
  const tokens = new Set<string>();

  for (const field of fields) {
    if (typeof field !== 'string' || field.length === 0) continue;

    for (const word of tokenise(field)) {
      for (const prefix of prefixesOf(word)) {
        tokens.add(prefix);
      }

      // Suffix tokens for digit runs, so "4567" finds 9123 4567.
      if (/^\d+$/.test(word) && word.length >= 4) {
        for (let start = 1; start <= word.length - MIN_PREFIX_LENGTH; start += 1) {
          const suffix = word.slice(start);
          if (suffix.length <= MAX_PREFIX_LENGTH) {
            tokens.add(suffix);
          }
        }
      }
    }
  }

  // Deterministic order keeps document diffs readable and audit entries stable.
  return [...tokens].sort().slice(0, MAX_TOKENS);
}

/**
 * Turn what the employee typed into the single token to query.
 *
 * Returns `null` when the input carries no searchable content, which callers
 * treat as "no query" rather than "no results".
 */
export function toSearchToken(query: string): string | null {
  const words = tokenise(query);
  if (words.length === 0) return null;

  /*
   * Query the longest word. `array-contains` accepts one value, and the longest
   * word is the most selective — searching "al" from "Fatima Al Balushi" would
   * return most of the collection.
   */
  const longest = words.reduce((best, word) => (word.length > best.length ? word : best), '');

  return longest.slice(0, MAX_PREFIX_LENGTH);
}

/**
 * Rank and filter candidates returned by the token query.
 *
 * The token match is deliberately loose — it finds documents containing *a*
 * matching word. This narrows to records matching *every* word the employee
 * typed, and orders exact-prefix matches first, so typing "fatima al" does not
 * rank an unrelated "Al Habsi" above "Fatima Al Balushi".
 */
export function rankMatches<T>(
  query: string,
  candidates: readonly T[],
  searchableText: (candidate: T) => string,
): T[] {
  const words = tokenise(query);
  if (words.length === 0) return [...candidates];

  const scored: { candidate: T; score: number }[] = [];

  for (const candidate of candidates) {
    const haystack = tokenise(searchableText(candidate));
    let score = 0;
    let matchedAll = true;

    for (const word of words) {
      const exact = haystack.some((token) => token === word);
      const prefix = haystack.some((token) => token.startsWith(word));

      /*
       * A digit query may match the middle or end of a longer number, because
       * that is what the index stores: `buildSearchTokens` emits suffix tokens
       * for digit runs so staff can search by the last four digits of a phone
       * number. Ranking has to accept the same matches the index returns, or a
       * record is found by the query and then silently filtered out here.
       */
      const digits = /^\d+$/.test(word);
      const contained = digits && haystack.some((token) => token.includes(word));

      if (exact) {
        score += 2;
      } else if (prefix) {
        score += 1;
      } else if (contained) {
        score += 1;
      } else {
        matchedAll = false;
        break;
      }
    }

    if (matchedAll) {
      scored.push({ candidate, score });
    }
  }

  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.candidate);
}
