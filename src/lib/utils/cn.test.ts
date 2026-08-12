import { describe, it, expect } from 'vitest';
import { cn } from './cn';

describe('cn()', () => {
  it('joins strings', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('skips falsy values', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b');
  });

  it('includes keys whose condition is true', () => {
    expect(cn('a', { b: true, c: false })).toBe('a b');
  });

  it('accepts numbers', () => {
    expect(cn(1, 'a')).toBe('1 a');
  });

  it('returns an empty string when nothing applies', () => {
    expect(cn(false, null, undefined)).toBe('');
  });
});
