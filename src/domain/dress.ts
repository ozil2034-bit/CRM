/**
 * Dress domain rules.
 *
 * Statuses, the transitions staff may make by hand, and the invariants a dress
 * record must satisfy.
 *
 * Deliberately excludes availability, cleaning-buffer conflict detection and
 * anything reservation-driven — that is Phase 4. What is here is the data
 * structure and the operational guards Phase 3 needs.
 *
 * Pure: no I/O, no Firebase, no clock.
 */

import type { Baisa } from './money';

export const DRESS_STATUSES = [
  'Available',
  'Reserved',
  'Out with Customer',
  'In Cleaning',
  'In Alteration',
  'Under Repair',
  'Retired',
] as const;

export type DressStatus = (typeof DRESS_STATUSES)[number];

export function isDressStatus(value: unknown): value is DressStatus {
  return typeof value === 'string' && (DRESS_STATUSES as readonly string[]).includes(value);
}

export const DRESS_CONDITIONS = ['New', 'Excellent', 'Good', 'Fair', 'Needs Repair'] as const;

export type DressCondition = (typeof DRESS_CONDITIONS)[number];

export function isDressCondition(value: unknown): value is DressCondition {
  return typeof value === 'string' && (DRESS_CONDITIONS as readonly string[]).includes(value);
}

/**
 * Statuses that are set by the reservation engine, never by hand.
 *
 * A staff member cannot mark a dress "Reserved" from the inventory screen: the
 * status is a consequence of a booking existing, and letting it be typed in
 * would let the inventory disagree with the reservations that drive it.
 * Phase 4 owns these transitions.
 */
export const RESERVATION_DRIVEN_STATUSES: readonly DressStatus[] = [
  'Reserved',
  'Out with Customer',
];

/**
 * Statuses that block a dress from being booked at all, independent of dates.
 *
 * Declared here in Phase 3 because the inventory screen must show it; the
 * booking check that consumes it arrives in Phase 4.
 */
export const OPERATIONALLY_BLOCKED_STATUSES: readonly DressStatus[] = [
  'In Alteration',
  'Under Repair',
  'Retired',
];

export function isOperationallyBlocked(status: DressStatus): boolean {
  return OPERATIONALLY_BLOCKED_STATUSES.includes(status);
}

/** Retired is the archive state for a dress; the record is never deleted. */
export function isArchived(status: DressStatus): boolean {
  return status === 'Retired';
}

export type StatusChangeRefusal =
  'RESERVATION_DRIVEN' | 'FROM_RESERVATION_DRIVEN' | 'RETIRED_IS_FINAL' | 'NO_CHANGE' | null;

/**
 * May a staff member move a dress to this status by hand?
 *
 * Returns `null` when the change is allowed, or the reason it is refused.
 *
 * Retiring is allowed from anywhere except while a customer physically holds the
 * dress — retiring a garment that is out would leave it with no route back into
 * the inventory when it returns.
 */
export function refuseManualStatusChange(from: DressStatus, to: DressStatus): StatusChangeRefusal {
  if (from === to) {
    return 'NO_CHANGE';
  }

  if (RESERVATION_DRIVEN_STATUSES.includes(to)) {
    return 'RESERVATION_DRIVEN';
  }

  if (RESERVATION_DRIVEN_STATUSES.includes(from)) {
    // Leaving Reserved or Out with Customer happens through the reservation
    // workflow (cancellation, return), not by editing the dress.
    return 'FROM_RESERVATION_DRIVEN';
  }

  if (from === 'Retired') {
    return 'RETIRED_IS_FINAL';
  }

  return null;
}

export const STATUS_REFUSAL_MESSAGES: Readonly<Record<Exclude<StatusChangeRefusal, null>, string>> =
  {
    RESERVATION_DRIVEN:
      'This status is set automatically when a reservation is created or collected.',
    FROM_RESERVATION_DRIVEN:
      'This dress is part of an active reservation. Change it through the reservation.',
    RETIRED_IS_FINAL: 'A retired dress cannot be returned to the inventory.',
    NO_CHANGE: 'The dress already has this status.',
  };

/* ------------------------------------------------------------------------ *
 * Measurements
 * ------------------------------------------------------------------------ */

export interface DressMeasurements {
  readonly bust: number | null;
  readonly waist: number | null;
  readonly hips: number | null;
  readonly length: number | null;
}

export const EMPTY_MEASUREMENTS: DressMeasurements = {
  bust: null,
  waist: null,
  hips: null,
  length: null,
};

/** Centimetres. Generous bounds — this rejects typos, not unusual garments. */
export const MEASUREMENT_MIN_CM = 10;
export const MEASUREMENT_MAX_CM = 300;

export function isValidMeasurement(value: number | null): boolean {
  if (value === null) return true;
  return Number.isFinite(value) && value >= MEASUREMENT_MIN_CM && value <= MEASUREMENT_MAX_CM;
}

/* ------------------------------------------------------------------------ *
 * Photos
 * ------------------------------------------------------------------------ */

export interface DressPhoto {
  readonly id: string;
  readonly storagePath: string;
  readonly thumbPath: string | null;
  readonly width: number;
  readonly height: number;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly uploadedAt: number;
  readonly uploadedBy: string;
}

/**
 * Resolve which photo leads.
 *
 * Falls back to the first photo when the recorded primary has been deleted, so
 * a dress never renders with no image while photos exist.
 */
export function resolvePrimaryPhoto(
  photos: readonly DressPhoto[],
  primaryPhotoId: string | null,
): DressPhoto | null {
  if (photos.length === 0) return null;

  if (primaryPhotoId !== null) {
    const named = photos.find((photo) => photo.id === primaryPhotoId);
    if (named) return named;
  }

  return photos[0] ?? null;
}

/**
 * Choose the primary after a photo is removed.
 *
 * Returns the id the record should now carry.
 */
export function primaryAfterRemoval(
  photos: readonly DressPhoto[],
  primaryPhotoId: string | null,
  removedId: string,
): string | null {
  const remaining = photos.filter((photo) => photo.id !== removedId);
  if (remaining.length === 0) return null;
  if (primaryPhotoId !== removedId) return primaryPhotoId;
  return remaining[0]?.id ?? null;
}

/* ------------------------------------------------------------------------ *
 * Pricing invariants
 * ------------------------------------------------------------------------ */

export type PricingProblem =
  'RENTAL_NEGATIVE' | 'DEPOSIT_NEGATIVE' | 'SALE_NEGATIVE' | 'COST_NEGATIVE';

export interface DressPricing {
  readonly rentalPrice: Baisa;
  readonly salePrice: Baisa | null;
  readonly securityDeposit: Baisa;
  readonly purchaseCost: Baisa | null;
}

/**
 * Validate money on a dress.
 *
 * Zero is permitted throughout: a boutique may hold a dress it does not rent
 * yet, or waive a deposit for a regular customer's family. Negative is not — a
 * negative rental price is a data-entry error that would flow straight into an
 * invoice total.
 */
export function findPricingProblems(pricing: DressPricing): PricingProblem[] {
  const problems: PricingProblem[] = [];

  if (pricing.rentalPrice < 0) problems.push('RENTAL_NEGATIVE');
  if (pricing.securityDeposit < 0) problems.push('DEPOSIT_NEGATIVE');
  if (pricing.salePrice !== null && pricing.salePrice < 0) problems.push('SALE_NEGATIVE');
  if (pricing.purchaseCost !== null && pricing.purchaseCost < 0) problems.push('COST_NEGATIVE');

  return problems;
}

/* ------------------------------------------------------------------------ *
 * Cleaning buffer
 * ------------------------------------------------------------------------ */

export const DEFAULT_CLEANING_BUFFER_DAYS = 2;
export const MAX_CLEANING_BUFFER_DAYS = 60;

export function isValidCleaningBuffer(days: number): boolean {
  return Number.isInteger(days) && days >= 0 && days <= MAX_CLEANING_BUFFER_DAYS;
}

/* ------------------------------------------------------------------------ *
 * Search text
 * ------------------------------------------------------------------------ */

export interface DressSearchableFields {
  readonly code: string;
  readonly name: string;
  readonly designer: string;
  readonly brand: string;
  readonly color: string;
  readonly size: string;
}

/** The fields fed to `buildSearchTokens` when a dress is written. */
export function dressSearchFields(dress: DressSearchableFields): string[] {
  return [dress.code, dress.name, dress.designer, dress.brand, dress.color, dress.size];
}
