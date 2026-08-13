/**
 * The accessory catalogue.
 *
 * Veils, tiaras, boleros, jewellery — the things a bride adds to a gown. A much
 * smaller model than a dress on purpose: an accessory has no measurements, no
 * cleaning buffer and, crucially, **no availability**.
 *
 * ## Why accessories do not block
 *
 * A dress is one physical garment, so booking it excludes everyone else and the
 * whole conflict engine exists to enforce that. A boutique holds several of most
 * accessories, and they are frequently sold rather than rented. Modelling them
 * as blocking resources would demand stock levels the boutique does not keep,
 * and would refuse bookings for a shortage nobody has actually observed.
 *
 * So an accessory is a **priced catalogue entry**. Adding one to a reservation
 * snapshots its price onto that booking and nothing else changes hands. If the
 * boutique later needs true stock control, that is a new model, not a flag here.
 *
 * Pure: no I/O, no Firebase, no clock.
 */

import type { Baisa } from './money';

/**
 * Retired rather than deleted, for the same reason dresses are.
 *
 * Reservations reference accessories by id for reporting. A deleted catalogue
 * entry would leave "which accessories earn their keep" unanswerable for every
 * past booking. Retiring hides it from the picker and keeps the history.
 */
export const ACCESSORY_STATUSES = ['Active', 'Retired'] as const;
export type AccessoryStatus = (typeof ACCESSORY_STATUSES)[number];

export function isAccessoryStatus(value: unknown): value is AccessoryStatus {
  return value === 'Active' || value === 'Retired';
}

/**
 * What an accessory is for.
 *
 * Rental and sale are genuinely different transactions: a sold veil does not
 * come back, so it carries no security deposit and no return date. Recording
 * which one an entry is stops staff having to remember per item.
 */
export const ACCESSORY_KINDS = ['Rental', 'Sale', 'Both'] as const;
export type AccessoryKind = (typeof ACCESSORY_KINDS)[number];

export function isAccessoryKind(value: unknown): value is AccessoryKind {
  return value === 'Rental' || value === 'Sale' || value === 'Both';
}

export const ACCESSORY_CATEGORIES = [
  'Veil',
  'Tiara',
  'Bolero',
  'Belt',
  'Jewellery',
  'Shoes',
  'Gloves',
  'Other',
] as const;

export type AccessoryCategory = (typeof ACCESSORY_CATEGORIES)[number];

export function isAccessoryCategory(value: unknown): value is AccessoryCategory {
  return typeof value === 'string' && (ACCESSORY_CATEGORIES as readonly string[]).includes(value);
}

export interface Accessory {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nameAr: string;
  readonly description: string;
  readonly descriptionAr: string;
  readonly category: AccessoryCategory;
  readonly kind: AccessoryKind;
  readonly rentalPrice: Baisa;
  /** Null when the boutique does not sell this item. */
  readonly salePrice: Baisa | null;
  readonly securityDeposit: Baisa;
  readonly photoPath: string | null;
  readonly status: AccessoryStatus;
}

/**
 * The price to charge when this accessory joins a reservation.
 *
 * A sale-only item has no rental price to fall back on, and quietly charging
 * zero would put a free veil on an invoice. Returning null makes the interface
 * say so instead.
 */
export function priceFor(accessory: Accessory, as: 'Rental' | 'Sale'): Baisa | null {
  if (as === 'Sale') {
    return accessory.kind === 'Rental' ? null : accessory.salePrice;
  }

  return accessory.kind === 'Sale' ? null : accessory.rentalPrice;
}

/**
 * The deposit to hold.
 *
 * A sold accessory carries none: the customer keeps it, so there is nothing to
 * secure its return.
 */
export function depositFor(accessory: Accessory, as: 'Rental' | 'Sale'): Baisa {
  return as === 'Sale' ? (0 as Baisa) : accessory.securityDeposit;
}

/** Whether this entry may still be added to a new reservation. */
export function isSelectable(accessory: Accessory): boolean {
  return accessory.status === 'Active';
}

/**
 * Filter and sort a catalogue for the picker.
 *
 * Retired entries are excluded unless explicitly asked for; the search term is
 * matched against both languages by the caller's normaliser, which is passed in
 * so this module stays free of the Arabic-folding implementation.
 */
export function selectableAccessories(
  catalogue: readonly Accessory[],
  filters: {
    readonly category?: AccessoryCategory | null;
    readonly includeRetired?: boolean;
  } = {},
): Accessory[] {
  return catalogue
    .filter((accessory) => filters.includeRetired === true || isSelectable(accessory))
    .filter(
      (accessory) =>
        (filters.category ?? null) === null || accessory.category === filters.category,
    )
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}
