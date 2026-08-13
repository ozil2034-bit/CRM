/**
 * Customer validation schemas.
 */

import { z } from 'zod';

import {
  CUSTOMER_SOURCES,
  MEASUREMENT_BOUNDS,
  PREFERRED_LANGUAGES,
  hasUsableName,
  isValidCalendarDate,
} from '@/domain/customer';
import { parseOmanPhone } from '@/domain/phone';

const trimmedText = (max: number) => z.string().trim().max(max);

const boundedMeasurement = (field: keyof typeof MEASUREMENT_BOUNDS) =>
  z
    .number()
    .min(MEASUREMENT_BOUNDS[field].min, 'That value looks too small.')
    .max(MEASUREMENT_BOUNDS[field].max, 'That value looks too large.')
    .nullable();

export const customerMeasurementsSchema = z.object({
  bust: boundedMeasurement('bust'),
  waist: boundedMeasurement('waist'),
  hips: boundedMeasurement('hips'),
  height: boundedMeasurement('height'),
  shoeSize: boundedMeasurement('shoeSize'),
});

export const customerFormSchema = z
  .object({
    nameEn: trimmedText(120),
    nameAr: trimmedText(120),

    /** Validated through the Oman parser so storage and search agree. */
    phone: z.string().trim().min(1, 'Enter a phone number.'),
    hasWhatsapp: z.boolean(),

    email: z.union([z.literal(''), z.email('Enter a valid email address.')]),

    /**
     * Optional and unindexed. It identifies a person to the state, so it is not
     * fed to search and is not required to create a record.
     */
    nationalId: trimmedText(40),

    eventDate: z.union([z.literal(''), z.string().trim()]),

    measurements: customerMeasurementsSchema,

    source: z.union([z.enum(CUSTOMER_SOURCES), z.literal('')]),
    preferredLanguage: z.enum(PREFERRED_LANGUAGES),
    notes: trimmedText(2000),
  })
  .refine((values) => hasUsableName(values.nameEn, values.nameAr), {
    // Either script alone is enough. Requiring both would force staff to
    // transliterate at the counter.
    message: 'Enter the customer’s name in English or Arabic.',
    path: ['nameEn'],
  })
  .refine((values) => parseOmanPhone(values.phone).ok, {
    message: 'Enter a valid Omani phone number.',
    path: ['phone'],
  })
  .refine((values) => values.eventDate === '' || isValidCalendarDate(values.eventDate), {
    message: 'Enter a real date.',
    path: ['eventDate'],
  });

export type CustomerFormValues = z.infer<typeof customerFormSchema>;

export const EMPTY_CUSTOMER_FORM: CustomerFormValues = {
  nameEn: '',
  nameAr: '',
  phone: '',
  hasWhatsapp: true,
  email: '',
  nationalId: '',
  eventDate: '',
  measurements: { bust: null, waist: null, hips: null, height: null, shoeSize: null },
  source: '',
  preferredLanguage: 'bilingual',
  notes: '',
};
