import { describe, it, expect } from 'vitest';
import { baisa } from './money';
import {
  DRESS_STATUSES,
  MAX_CLEANING_BUFFER_DAYS,
  dressSearchFields,
  findPricingProblems,
  isArchived,
  isDressCondition,
  isDressStatus,
  isOperationallyBlocked,
  isValidCleaningBuffer,
  isValidMeasurement,
  primaryAfterRemoval,
  refuseManualStatusChange,
  resolvePrimaryPhoto,
  type DressPhoto,
  type DressStatus,
} from './dress';

describe('dress status', () => {
  it('defines exactly the specified statuses', () => {
    expect(DRESS_STATUSES).toEqual([
      'Available',
      'Reserved',
      'Out with Customer',
      'In Cleaning',
      'In Alteration',
      'Under Repair',
      'Retired',
    ]);
  });

  it('recognises valid statuses and rejects anything else', () => {
    expect(isDressStatus('Available')).toBe(true);
    expect(isDressStatus('available')).toBe(false);
    expect(isDressStatus('Sold')).toBe(false);
    expect(isDressStatus(null)).toBe(false);
  });

  it('recognises valid conditions', () => {
    expect(isDressCondition('Excellent')).toBe(true);
    expect(isDressCondition('Pristine')).toBe(false);
  });

  it('marks alteration, repair and retirement as booking blocks', () => {
    expect(isOperationallyBlocked('In Alteration')).toBe(true);
    expect(isOperationallyBlocked('Under Repair')).toBe(true);
    expect(isOperationallyBlocked('Retired')).toBe(true);
  });

  it('does not treat cleaning as an operational block', () => {
    // Cleaning is time-bounded and handled by the buffer in Phase 4, not by
    // refusing the dress outright.
    expect(isOperationallyBlocked('In Cleaning')).toBe(false);
    expect(isOperationallyBlocked('Available')).toBe(false);
  });

  it('treats Retired as the archive state', () => {
    expect(isArchived('Retired')).toBe(true);
    expect(isArchived('Available')).toBe(false);
  });
});

describe('refuseManualStatusChange()', () => {
  it('allows ordinary operational moves', () => {
    expect(refuseManualStatusChange('Available', 'In Cleaning')).toBeNull();
    expect(refuseManualStatusChange('Available', 'In Alteration')).toBeNull();
    expect(refuseManualStatusChange('In Cleaning', 'Available')).toBeNull();
    expect(refuseManualStatusChange('Under Repair', 'Available')).toBeNull();
  });

  it('allows retiring a dress that is on the rail', () => {
    expect(refuseManualStatusChange('Available', 'Retired')).toBeNull();
    expect(refuseManualStatusChange('Under Repair', 'Retired')).toBeNull();
  });

  it('refuses setting reservation-driven statuses by hand', () => {
    // Letting staff type "Reserved" would allow the inventory to disagree with
    // the reservations that drive it.
    expect(refuseManualStatusChange('Available', 'Reserved')).toBe('RESERVATION_DRIVEN');
    expect(refuseManualStatusChange('Available', 'Out with Customer')).toBe('RESERVATION_DRIVEN');
  });

  it('refuses moving away from a reservation-driven status by hand', () => {
    expect(refuseManualStatusChange('Reserved', 'Available')).toBe('FROM_RESERVATION_DRIVEN');
    expect(refuseManualStatusChange('Out with Customer', 'In Cleaning')).toBe(
      'FROM_RESERVATION_DRIVEN',
    );
  });

  it('refuses retiring a dress a customer currently holds', () => {
    // Retiring it would leave no route back into the inventory when it returns.
    expect(refuseManualStatusChange('Out with Customer', 'Retired')).toBe(
      'FROM_RESERVATION_DRIVEN',
    );
  });

  it('treats retirement as final', () => {
    expect(refuseManualStatusChange('Retired', 'Available')).toBe('RETIRED_IS_FINAL');
  });

  it('reports a no-op rather than silently accepting it', () => {
    for (const status of DRESS_STATUSES) {
      expect(refuseManualStatusChange(status, status)).toBe('NO_CHANGE');
    }
  });

  it('gives a defined answer for every status pair', () => {
    for (const from of DRESS_STATUSES) {
      for (const to of DRESS_STATUSES) {
        const verdict = refuseManualStatusChange(from as DressStatus, to as DressStatus);
        expect(verdict === null || typeof verdict === 'string').toBe(true);
      }
    }
  });
});

describe('measurements and cleaning buffer', () => {
  it('accepts an absent measurement', () => {
    expect(isValidMeasurement(null)).toBe(true);
  });

  it('accepts plausible values and rejects typos', () => {
    expect(isValidMeasurement(86)).toBe(true);
    expect(isValidMeasurement(9)).toBe(false);
    expect(isValidMeasurement(3000)).toBe(false);
    expect(isValidMeasurement(Number.NaN)).toBe(false);
  });

  it('accepts a zero cleaning buffer and rejects negatives', () => {
    expect(isValidCleaningBuffer(0)).toBe(true);
    expect(isValidCleaningBuffer(2)).toBe(true);
    expect(isValidCleaningBuffer(MAX_CLEANING_BUFFER_DAYS)).toBe(true);
    expect(isValidCleaningBuffer(-1)).toBe(false);
    expect(isValidCleaningBuffer(MAX_CLEANING_BUFFER_DAYS + 1)).toBe(false);
    expect(isValidCleaningBuffer(1.5)).toBe(false);
  });
});

describe('photos', () => {
  const photo = (id: string): DressPhoto => ({
    id,
    storagePath: `dresses/d1/original/${id}.webp`,
    thumbPath: `dresses/d1/thumb/${id}.webp`,
    width: 1200,
    height: 1800,
    contentType: 'image/webp',
    sizeBytes: 100_000,
    uploadedAt: 0,
    uploadedBy: 'staff-1',
  });

  it('resolves the named primary', () => {
    const photos = [photo('a'), photo('b')];
    expect(resolvePrimaryPhoto(photos, 'b')?.id).toBe('b');
  });

  it('falls back to the first photo when the named primary is gone', () => {
    // Otherwise a dress with photos would render with no image.
    const photos = [photo('a'), photo('b')];
    expect(resolvePrimaryPhoto(photos, 'deleted')?.id).toBe('a');
  });

  it('falls back to the first photo when none is named', () => {
    expect(resolvePrimaryPhoto([photo('a')], null)?.id).toBe('a');
  });

  it('returns null when there are no photos', () => {
    expect(resolvePrimaryPhoto([], null)).toBeNull();
    expect(resolvePrimaryPhoto([], 'a')).toBeNull();
  });

  it('promotes the next photo when the primary is removed', () => {
    const photos = [photo('a'), photo('b'), photo('c')];
    expect(primaryAfterRemoval(photos, 'a', 'a')).toBe('b');
  });

  it('leaves the primary alone when another photo is removed', () => {
    const photos = [photo('a'), photo('b')];
    expect(primaryAfterRemoval(photos, 'a', 'b')).toBe('a');
  });

  it('clears the primary when the last photo is removed', () => {
    expect(primaryAfterRemoval([photo('a')], 'a', 'a')).toBeNull();
  });
});

describe('findPricingProblems()', () => {
  const base = {
    rentalPrice: baisa(180_000),
    salePrice: null,
    securityDeposit: baisa(100_000),
    purchaseCost: null,
  };

  it('accepts valid pricing', () => {
    expect(findPricingProblems(base)).toEqual([]);
  });

  it('accepts zero throughout', () => {
    // A boutique may hold a dress it does not rent yet, or waive a deposit.
    expect(
      findPricingProblems({
        rentalPrice: baisa(0),
        salePrice: baisa(0),
        securityDeposit: baisa(0),
        purchaseCost: baisa(0),
      }),
    ).toEqual([]);
  });

  it('rejects negative amounts, which would flow into an invoice total', () => {
    expect(findPricingProblems({ ...base, rentalPrice: baisa(-1) })).toContain('RENTAL_NEGATIVE');
    expect(findPricingProblems({ ...base, securityDeposit: baisa(-1) })).toContain(
      'DEPOSIT_NEGATIVE',
    );
    expect(findPricingProblems({ ...base, salePrice: baisa(-1) })).toContain('SALE_NEGATIVE');
    expect(findPricingProblems({ ...base, purchaseCost: baisa(-1) })).toContain('COST_NEGATIVE');
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const problems = findPricingProblems({
      rentalPrice: baisa(-1),
      salePrice: baisa(-1),
      securityDeposit: baisa(-1),
      purchaseCost: baisa(-1),
    });
    expect(problems).toHaveLength(4);
  });
});

describe('dressSearchFields()', () => {
  it('includes the fields staff search a dress by', () => {
    const fields = dressSearchFields({
      code: 'WD-0001',
      name: 'Aurora',
      designer: 'Elie Saab',
      brand: 'Couture',
      color: 'Ivory',
      size: '38',
    });

    expect(fields).toContain('WD-0001');
    expect(fields).toContain('Aurora');
    expect(fields).toContain('Elie Saab');
  });
});
