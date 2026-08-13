/**
 * Finding an alternative when the chosen dress is taken.
 *
 * A bride who wanted a particular gown for a particular week is not helped by
 * "unavailable". She is helped by three gowns that are close to it and free.
 * This module decides what "close" means, and — just as importantly — what is
 * not offerable at all.
 *
 * Ranking only. It never asserts availability: the caller supplies the set of
 * dresses already known to be free, because availability can only be judged
 * against blocking intervals, and authoritatively only inside the reservation
 * transaction.
 */

import type { Baisa } from './money';

/** The dress attributes this module reasons about. */
export interface SimilarityCandidate {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly size: string;
  readonly style: string;
  readonly color: string;
  readonly designer: string;
  readonly rentalPrice: Baisa;
  readonly status: string;
}

/**
 * Statuses that can never be offered as an alternative.
 *
 * These are about the gown itself, not about dates: a retired dress is gone,
 * and one under repair or in alteration is physically unavailable for a period
 * nobody has committed to. Suggesting any of them would produce a booking the
 * boutique cannot honour. `Sold` is included for the same reason.
 */
export const NON_OFFERABLE_STATUSES: ReadonlySet<string> = new Set([
  'Retired',
  'Under Repair',
  'In Alteration',
  'Sold',
]);

/**
 * Weights, in descending order of how much a bride actually cares.
 *
 * Size leads because a gown that does not fit is not an alternative at any
 * price — alterations take weeks the boutique may not have. Style is next: it
 * is what she chose the dress for. Colour follows, then designer, which
 * matters to some customers and not at all to others. Price proximity breaks
 * ties rather than driving the ranking, so a cheaper near-match never displaces
 * a better one.
 */
const WEIGHT_SIZE = 60;
const WEIGHT_STYLE = 25;
const WEIGHT_COLOR = 15;
const WEIGHT_DESIGNER = 10;
const WEIGHT_PRICE_MAX = 9;

/*
 * Size is deliberately worth more than every other attribute combined
 * (25 + 15 + 10 + 9 = 59). Anything less lets a gown in the wrong size tie with
 * one that fits, and the wrong-sized gown is not an alternative at all — the
 * bride cannot wear it on the day.
 */

/** Within this fraction of the original price, a gown counts as comparable. */
const PRICE_BAND = 0.25;

export interface SimilarityResult {
  readonly candidate: SimilarityCandidate;
  readonly score: number;
  /** Attributes that matched, for showing the employee *why* it is suggested. */
  readonly matched: readonly ('size' | 'style' | 'color' | 'designer' | 'price')[];
}

const normalise = (value: string): string => value.trim().toLowerCase();

/** Case- and whitespace-insensitive equality, with blanks never matching. */
function sameAttribute(a: string, b: string): boolean {
  const left = normalise(a);
  return left.length > 0 && left === normalise(b);
}

/**
 * Score one candidate against the dress the customer actually wanted.
 *
 * A blank attribute on either side scores zero rather than matching another
 * blank: two dresses with no recorded designer have nothing in common.
 */
export function scoreSimilarity(
  target: SimilarityCandidate,
  candidate: SimilarityCandidate,
): SimilarityResult {
  const matched: ('size' | 'style' | 'color' | 'designer' | 'price')[] = [];
  let score = 0;

  if (sameAttribute(target.size, candidate.size)) {
    score += WEIGHT_SIZE;
    matched.push('size');
  }
  if (sameAttribute(target.style, candidate.style)) {
    score += WEIGHT_STYLE;
    matched.push('style');
  }
  if (sameAttribute(target.color, candidate.color)) {
    score += WEIGHT_COLOR;
    matched.push('color');
  }
  if (sameAttribute(target.designer, candidate.designer)) {
    score += WEIGHT_DESIGNER;
    matched.push('designer');
  }

  /*
   * Price proximity, scored on a linear taper inside the band. Computed in
   * integer baisa; the division is a ratio for ranking only and never becomes
   * a money value.
   */
  if (target.rentalPrice > 0) {
    const distance = Math.abs(candidate.rentalPrice - target.rentalPrice) / target.rentalPrice;
    if (distance <= PRICE_BAND) {
      score += Math.round(WEIGHT_PRICE_MAX * (1 - distance / PRICE_BAND));
      matched.push('price');
    }
  }

  return { candidate, score, matched };
}

export interface FindSimilarOptions {
  /** Dresses free for the requested dates, decided by the caller. */
  readonly availableDresses: readonly SimilarityCandidate[];
  readonly limit?: number;
}

/**
 * Rank alternatives to a dress that could not be booked.
 *
 * Excludes the target itself, anything non-offerable, and anything scoring
 * nothing at all — an unrelated gown offered as a "similar dress" damages
 * trust in every later suggestion.
 */
export function findSimilarDresses(
  target: SimilarityCandidate,
  options: FindSimilarOptions,
): readonly SimilarityResult[] {
  const limit = options.limit ?? 3;

  return options.availableDresses
    .filter(
      (candidate) => candidate.id !== target.id && !NON_OFFERABLE_STATUSES.has(candidate.status),
    )
    .map((candidate) => scoreSimilarity(target, candidate))
    .filter((result) => result.score > 0)
    .sort(
      (a, b) =>
        // Ties broken by code, so the same query always returns the same order.
        b.score - a.score || a.candidate.code.localeCompare(b.candidate.code),
    )
    .slice(0, limit);
}
