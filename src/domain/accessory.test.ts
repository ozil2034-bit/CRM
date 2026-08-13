import { describe, expect, it } from 'vitest';

import {
  depositFor,
  isAccessoryCategory,
  isAccessoryKind,
  isAccessoryStatus,
  isSelectable,
  priceFor,
  selectableAccessories,
  type Accessory,
} from './accessory';
import { baisa } from './money';

function accessory(overrides: Partial<Accessory> = {}): Accessory {
  return {
    id: 'a-1',
    code: 'ACC-0001',
    name: 'Cathedral veil',
    nameAr: 'طرحة كاتدرائية',
    description: '',
    descriptionAr: '',
    category: 'Veil',
    kind: 'Rental',
    rentalPrice: baisa(20_000),
    salePrice: baisa(60_000),
    securityDeposit: baisa(5_000),
    photoPath: null,
    status: 'Active',
    ...overrides,
  };
}

describe('the type guards', () => {
  it('recognise the statuses, kinds and categories', () => {
    expect(isAccessoryStatus('Active')).toBe(true);
    expect(isAccessoryStatus('Archived')).toBe(false);
    expect(isAccessoryKind('Both')).toBe(true);
    expect(isAccessoryKind('Lease')).toBe(false);
    expect(isAccessoryCategory('Tiara')).toBe(true);
    expect(isAccessoryCategory('Hat')).toBe(false);
  });
});

describe('pricing an accessory', () => {
  it('charges the rental price when rented', () => {
    expect(priceFor(accessory(), 'Rental')).toBe(20_000);
  });

  it('charges the sale price when sold', () => {
    expect(priceFor(accessory({ kind: 'Both' }), 'Sale')).toBe(60_000);
  });

  it('reports NO price rather than zero for a rental-only item being sold', () => {
    /*
     * Load-bearing. Falling back to zero would put a free veil on an invoice and
     * nobody would notice until the month's revenue was short.
     */
    expect(priceFor(accessory({ kind: 'Rental' }), 'Sale')).toBeNull();
  });

  it('reports no price for a sale-only item being rented', () => {
    expect(priceFor(accessory({ kind: 'Sale' }), 'Rental')).toBeNull();
  });

  it('reports no sale price when none was set, even on a Both item', () => {
    expect(priceFor(accessory({ kind: 'Both', salePrice: null }), 'Sale')).toBeNull();
  });
});

describe('the deposit on an accessory', () => {
  it('is held for a rental', () => {
    expect(depositFor(accessory(), 'Rental')).toBe(5_000);
  });

  it('is NOT held for a sale — the customer keeps it', () => {
    expect(depositFor(accessory({ kind: 'Both' }), 'Sale')).toBe(0);
  });
});

describe('the picker', () => {
  it('excludes retired entries by default', () => {
    const catalogue = [accessory(), accessory({ id: 'a-2', status: 'Retired', name: 'Old belt' })];

    expect(selectableAccessories(catalogue).map((entry) => entry.id)).toEqual(['a-1']);
  });

  it('includes retired entries when asked, for reporting on past bookings', () => {
    const catalogue = [accessory(), accessory({ id: 'a-2', status: 'Retired', name: 'Old belt' })];

    expect(selectableAccessories(catalogue, { includeRetired: true })).toHaveLength(2);
  });

  it('filters by category', () => {
    const catalogue = [accessory(), accessory({ id: 'a-2', category: 'Tiara', name: 'Pearl' })];

    expect(selectableAccessories(catalogue, { category: 'Tiara' }).map((e) => e.id)).toEqual([
      'a-2',
    ]);
  });

  it('sorts by name so the list does not reshuffle between visits', () => {
    const catalogue = [
      accessory({ id: 'a-1', name: 'Zircon belt' }),
      accessory({ id: 'a-2', name: 'Alabaster veil' }),
    ];

    expect(selectableAccessories(catalogue).map((entry) => entry.name)).toEqual([
      'Alabaster veil',
      'Zircon belt',
    ]);
  });

  it('returns an empty list for an empty catalogue rather than inventing entries', () => {
    expect(selectableAccessories([])).toEqual([]);
  });

  it('agrees with isSelectable', () => {
    expect(isSelectable(accessory())).toBe(true);
    expect(isSelectable(accessory({ status: 'Retired' }))).toBe(false);
  });
});
