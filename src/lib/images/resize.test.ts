import { describe, it, expect } from 'vitest';
import { fitWithin } from './resize';

describe('fitWithin()', () => {
  it('leaves an image smaller than the limit untouched', () => {
    // Upscaling adds bytes and no detail.
    expect(fitWithin({ width: 800, height: 600 }, 1600)).toEqual({ width: 800, height: 600 });
  });

  it('scales a landscape image by its width', () => {
    expect(fitWithin({ width: 4000, height: 3000 }, 1600)).toEqual({
      width: 1600,
      height: 1200,
    });
  });

  it('scales a portrait image by its height', () => {
    // Dress photographs are portrait; constraining the wrong edge would leave
    // them far larger than intended.
    expect(fitWithin({ width: 3000, height: 4000 }, 1600)).toEqual({
      width: 1200,
      height: 1600,
    });
  });

  it('preserves the aspect ratio — a stretched gown misrepresents the garment', () => {
    const source = { width: 3024, height: 4032 };
    const result = fitWithin(source, 480);

    const sourceRatio = source.width / source.height;
    const resultRatio = result.width / result.height;

    expect(Math.abs(sourceRatio - resultRatio)).toBeLessThan(0.01);
  });

  it('handles a square image', () => {
    expect(fitWithin({ width: 2000, height: 2000 }, 480)).toEqual({ width: 480, height: 480 });
  });

  it('never collapses an extreme aspect ratio to zero', () => {
    // Flooring a very wide, very short image could otherwise produce height 0.
    const result = fitWithin({ width: 10_000, height: 3 }, 480);
    expect(result.height).toBeGreaterThanOrEqual(1);
    expect(result.width).toBe(480);
  });

  it('rejects invalid inputs rather than producing nonsense dimensions', () => {
    expect(() => fitWithin({ width: 0, height: 100 }, 480)).toThrow();
    expect(() => fitWithin({ width: 100, height: 0 }, 480)).toThrow();
    expect(() => fitWithin({ width: 100, height: 100 }, 0)).toThrow();
    expect(() => fitWithin({ width: 100, height: 100 }, -1)).toThrow();
  });
});
