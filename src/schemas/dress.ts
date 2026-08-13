/**
 * Dress validation schemas.
 *
 * One schema, used by the form, the service and the tests, so a rule cannot be
 * enforced in one place and forgotten in another. Types are inferred from the
 * schema rather than declared alongside it, which makes them impossible to
 * drift.
 */

import { z } from 'zod';

import {
  DRESS_CONDITIONS,
  DRESS_STATUSES,
  MAX_CLEANING_BUFFER_DAYS,
  MEASUREMENT_MAX_CM,
  MEASUREMENT_MIN_CM,
} from '@/domain/dress';
import { MAX_BAISA } from '@/domain/money';

/** Money arrives from the form already converted to integer baisa. */
const baisaAmount = z
  .number({ error: 'Enter an amount.' })
  .int('Amounts are held in whole baisa.')
  .min(0, 'An amount cannot be negative.')
  .max(MAX_BAISA, 'That amount is too large.');

const optionalMeasurement = z
  .number()
  .min(MEASUREMENT_MIN_CM, `Measurements are in centimetres (minimum ${MEASUREMENT_MIN_CM}).`)
  .max(MEASUREMENT_MAX_CM, `That measurement looks too large.`)
  .nullable();

export const dressMeasurementsSchema = z.object({
  bust: optionalMeasurement,
  waist: optionalMeasurement,
  hips: optionalMeasurement,
  length: optionalMeasurement,
});

const trimmedText = (max: number) => z.string().trim().max(max);

/**
 * What the employee fills in.
 *
 * Only `name` is required. A dress arriving at the boutique has a name before
 * anyone has measured it, chosen a rail or photographed it, and forcing every
 * field up front would push staff into entering placeholder values — which is
 * worse than an incomplete record that says so.
 */
export const dressFormSchema = z.object({
  name: z.string().trim().min(1, 'A dress needs a name.').max(120, 'That name is too long.'),
  designer: trimmedText(120),
  brand: trimmedText(120),
  size: trimmedText(30),
  color: trimmedText(60),
  style: trimmedText(60),
  condition: z.enum(DRESS_CONDITIONS),

  measurements: dressMeasurementsSchema,

  rentalPrice: baisaAmount,
  salePrice: baisaAmount.nullable(),
  securityDeposit: baisaAmount,

  /**
   * Owner-only. The service omits it entirely for staff, and the rules refuse a
   * staff write to the subcollection it lives in.
   */
  purchaseCost: baisaAmount.nullable(),

  location: trimmedText(80),
  cleaningBufferDays: z
    .number()
    .int('Enter a whole number of days.')
    .min(0, 'A buffer cannot be negative.')
    .max(MAX_CLEANING_BUFFER_DAYS, `The maximum buffer is ${MAX_CLEANING_BUFFER_DAYS} days.`),

  notes: trimmedText(2000),
});

export type DressFormValues = z.infer<typeof dressFormSchema>;

export const dressStatusSchema = z.enum(DRESS_STATUSES);

/** A stored dress photo reference. Bytes live in Storage; this is the pointer. */
export const dressPhotoSchema = z.object({
  id: z.string().min(1),
  storagePath: z.string().min(1),
  thumbPath: z.string().min(1).nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  uploadedAt: z.number().int().nonnegative(),
  uploadedBy: z.string().min(1),
});

export type DressPhotoRecord = z.infer<typeof dressPhotoSchema>;

/** Sensible starting point for a new dress form. No invented values. */
export const EMPTY_DRESS_FORM: DressFormValues = {
  name: '',
  designer: '',
  brand: '',
  size: '',
  color: '',
  style: '',
  condition: 'Excellent',
  measurements: { bust: null, waist: null, hips: null, length: null },
  rentalPrice: 0,
  salePrice: null,
  securityDeposit: 0,
  purchaseCost: null,
  location: '',
  cleaningBufferDays: 2,
  notes: '',
};
