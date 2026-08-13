import { describe, it, expect } from 'vitest';
import { MAX_UPLOAD_BYTES, PHOTO_REJECTION_MESSAGES, rejectFile } from './photos.service';

/**
 * Client-side upload validation.
 *
 * These limits mirror the Storage rules exactly. Checking here does not replace
 * the rule — it means the employee is told immediately, and a 40 MB file is
 * never put on the wire at all.
 */
describe('rejectFile()', () => {
  it('accepts the formats the Storage rules allow', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(rejectFile({ type, size: 500_000 })).toBeNull();
    }
  });

  it('rejects SVG — it is an image type that can carry script', () => {
    expect(rejectFile({ type: 'image/svg+xml', size: 1000 })).toBe('UNSUPPORTED_TYPE');
  });

  it('rejects documents and executables', () => {
    for (const type of ['application/pdf', 'application/x-msdownload', 'text/html']) {
      expect(rejectFile({ type, size: 1000 })).toBe('UNSUPPORTED_TYPE');
    }
  });

  it('rejects a file at or above the size ceiling', () => {
    expect(rejectFile({ type: 'image/png', size: MAX_UPLOAD_BYTES })).toBe('TOO_LARGE');
    expect(rejectFile({ type: 'image/png', size: MAX_UPLOAD_BYTES + 1 })).toBe('TOO_LARGE');
  });

  it('accepts a file just under the ceiling', () => {
    expect(rejectFile({ type: 'image/png', size: MAX_UPLOAD_BYTES - 1 })).toBeNull();
  });

  it('rejects an empty file', () => {
    expect(rejectFile({ type: 'image/png', size: 0 })).toBe('EMPTY_FILE');
  });

  it('checks size before type, so an enormous PNG is refused for its size', () => {
    expect(rejectFile({ type: 'image/png', size: 50_000_000 })).toBe('TOO_LARGE');
  });

  it('has a message for every rejection', () => {
    for (const rejection of [
      'UNSUPPORTED_TYPE',
      'TOO_LARGE',
      'EMPTY_FILE',
      'NOT_AN_IMAGE',
    ] as const) {
      expect(PHOTO_REJECTION_MESSAGES[rejection].length).toBeGreaterThan(0);
    }
  });
});
