import { describe, expect, it } from 'vitest';

import { baisa } from './money';
import {
  findSimilarDresses,
  NON_OFFERABLE_STATUSES,
  scoreSimilarity,
  type SimilarityCandidate,
} from './similar-dresses';

function dress(overrides: Partial<SimilarityCandidate> = {}): SimilarityCandidate {
  return {
    id: 'target',
    code: 'WD-0001',
    name: 'Aurora',
    size: 'M',
    style: 'A-line',
    color: 'Ivory',
    designer: 'Elie Saab',
    rentalPrice: baisa(200_000),
    status: 'Available',
    ...overrides,
  };
}

describe('scoreSimilarity', () => {
  it('scores an identical dress highest', () => {
    const target = dress();
    const twin = dress({ id: 'twin', code: 'WD-0002' });

    const result = scoreSimilarity(target, twin);

    expect(result.matched).toEqual(['size', 'style', 'color', 'designer', 'price']);
    expect(result.score).toBe(60 + 25 + 15 + 10 + 9);
  });

  it('scores nothing for a dress with no attribute in common', () => {
    const result = scoreSimilarity(
      dress(),
      dress({
        id: 'other',
        size: 'XL',
        style: 'Mermaid',
        color: 'Blush',
        designer: 'Zuhair Murad',
        rentalPrice: baisa(500_000),
      }),
    );

    expect(result.score).toBe(0);
    expect(result.matched).toEqual([]);
  });

  it('weighs size above everything else', () => {
    const target = dress();

    const rightSize = scoreSimilarity(
      target,
      dress({
        id: 'a',
        size: 'M',
        style: 'Mermaid',
        color: 'Blush',
        designer: 'Other',
        rentalPrice: baisa(500_000),
      }),
    );
    const everythingElse = scoreSimilarity(
      target,
      dress({ id: 'b', size: 'XS', rentalPrice: baisa(500_000) }),
    );

    // Style + colour + designer together still lose to a gown that fits.
    expect(rightSize.score).toBeGreaterThan(everythingElse.score);
  });

  it('does not match two blank attributes with each other', () => {
    const target = dress({ designer: '' });
    const candidate = dress({ id: 'other', designer: '' });

    expect(scoreSimilarity(target, candidate).matched).not.toContain('designer');
  });

  it('ignores case and surrounding whitespace', () => {
    const result = scoreSimilarity(dress(), dress({ id: 'other', size: ' m ', style: 'a-line' }));

    expect(result.matched).toContain('size');
    expect(result.matched).toContain('style');
  });

  it('awards price proximity on a taper and nothing outside the band', () => {
    const target = dress({ rentalPrice: baisa(200_000) });

    const exact = scoreSimilarity(target, dress({ id: 'a', rentalPrice: baisa(200_000) }));
    const near = scoreSimilarity(target, dress({ id: 'b', rentalPrice: baisa(220_000) }));
    const outside = scoreSimilarity(target, dress({ id: 'c', rentalPrice: baisa(300_000) }));

    expect(exact.matched).toContain('price');
    expect(near.matched).toContain('price');
    expect(outside.matched).not.toContain('price');
    expect(exact.score).toBeGreaterThan(near.score);
  });

  it('does not divide by a zero price', () => {
    const result = scoreSimilarity(
      dress({ rentalPrice: baisa(0) }),
      dress({ id: 'other', rentalPrice: baisa(0) }),
    );

    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.matched).not.toContain('price');
  });
});

describe('findSimilarDresses', () => {
  const target = dress();

  it('never suggests the dress that was unavailable', () => {
    const results = findSimilarDresses(target, { availableDresses: [target] });
    expect(results).toHaveLength(0);
  });

  for (const status of [...NON_OFFERABLE_STATUSES]) {
    it(`never suggests a dress that is ${status}`, () => {
      const results = findSimilarDresses(target, {
        availableDresses: [dress({ id: 'other', code: 'WD-0002', status })],
      });

      expect(results).toHaveLength(0);
    });
  }

  it('never suggests a dress with nothing in common', () => {
    const results = findSimilarDresses(target, {
      availableDresses: [
        dress({
          id: 'unrelated',
          code: 'WD-0009',
          size: 'XL',
          style: 'Mermaid',
          color: 'Blush',
          designer: 'Other',
          rentalPrice: baisa(900_000),
        }),
      ],
    });

    expect(results).toHaveLength(0);
  });

  it('ranks the closest match first', () => {
    const results = findSimilarDresses(target, {
      availableDresses: [
        dress({
          id: 'colour-only',
          code: 'WD-0003',
          size: 'XL',
          style: 'Mermaid',
          designer: 'Other',
          rentalPrice: baisa(900_000),
        }),
        dress({ id: 'near-twin', code: 'WD-0002' }),
        dress({
          id: 'size-only',
          code: 'WD-0004',
          style: 'Mermaid',
          color: 'Blush',
          designer: 'Other',
          rentalPrice: baisa(900_000),
        }),
      ],
    });

    expect(results.map((result) => result.candidate.id)).toEqual([
      'near-twin',
      'size-only',
      'colour-only',
    ]);
  });

  it('returns three suggestions by default', () => {
    const results = findSimilarDresses(target, {
      availableDresses: Array.from({ length: 10 }, (_, index) =>
        dress({ id: `d-${index}`, code: `WD-01${index}` }),
      ),
    });

    expect(results).toHaveLength(3);
  });

  it('honours an explicit limit', () => {
    const results = findSimilarDresses(target, {
      availableDresses: Array.from({ length: 10 }, (_, index) =>
        dress({ id: `d-${index}`, code: `WD-01${index}` }),
      ),
      limit: 5,
    });

    expect(results).toHaveLength(5);
  });

  it('orders equal scores by code, so the same query gives the same answer', () => {
    const results = findSimilarDresses(target, {
      availableDresses: [
        dress({ id: 'b', code: 'WD-0300' }),
        dress({ id: 'a', code: 'WD-0100' }),
        dress({ id: 'c', code: 'WD-0200' }),
      ],
    });

    expect(results.map((result) => result.candidate.code)).toEqual([
      'WD-0100',
      'WD-0200',
      'WD-0300',
    ]);
  });

  it('explains why each dress was suggested', () => {
    const results = findSimilarDresses(target, {
      availableDresses: [
        dress({ id: 'other', code: 'WD-0002', style: 'Mermaid', designer: 'Other' }),
      ],
    });

    expect(results[0]!.matched).toEqual(['size', 'color', 'price']);
  });

  it('returns nothing when nothing is free', () => {
    expect(findSimilarDresses(target, { availableDresses: [] })).toHaveLength(0);
  });
});
