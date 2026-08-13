/**
 * Accessory validation.
 *
 * The same schema drives the form, the service and the tests, so a rule cannot
 * be enforced in one place and forgotten in another.
 */

import { z } from 'zod';

import { ACCESSORY_CATEGORIES, ACCESSORY_KINDS, ACCESSORY_STATUSES } from '@/domain/accessory';
import { MAX_BAISA } from '@/domain/money';

/** Money arrives from the form already converted to integer baisa. */
const baisaAmount = z
  .number({ error: 'Enter an amount.' })
  .int('Amounts are held in whole baisa.')
  .min(0, 'An amount cannot be negative.')
  .max(MAX_BAISA, 'That amount is too large.');

const trimmedText = (max: number) => z.string().trim().max(max);

/**
 * What the employee fills in.
 *
 * Only the name is required, for the same reason a dress needs only a name: a
 * box of veils arrives before anyone has decided what to charge, and forcing
 * every field up front pushes staff into inventing values.
 */
export const accessoryFormSchema = z
  .object({
    name: z.string().trim().min(1, 'An accessory needs a name.').max(120, 'That name is too long.'),
    nameAr: trimmedText(120),
    description: trimmedText(500),
    descriptionAr: trimmedText(500),

    category: z.enum(ACCESSORY_CATEGORIES),
    kind: z.enum(ACCESSORY_KINDS),

    rentalPrice: baisaAmount,
    salePrice: baisaAmount.nullable(),
    securityDeposit: baisaAmount,
  })
  /*
   * A sale-only entry with no sale price cannot be added to a reservation at
   * all — `priceFor` returns null and the picker refuses it. Catching it here
   * means the employee is told while they are still on the form, rather than
   * discovering it weeks later with a customer waiting.
   */
  .refine((values) => values.kind === 'Rental' || values.salePrice !== null, {
    path: ['salePrice'],
    error: 'An accessory that can be sold needs a sale price.',
  });

export type AccessoryFormValues = z.infer<typeof accessoryFormSchema>;

export const accessoryStatusSchema = z.enum(ACCESSORY_STATUSES);

/** A blank form. No invented prices. */
export const EMPTY_ACCESSORY_FORM: AccessoryFormValues = {
  name: '',
  nameAr: '',
  description: '',
  descriptionAr: '',
  category: 'Veil',
  kind: 'Rental',
  rentalPrice: 0,
  salePrice: null,
  securityDeposit: 0,
};
