/**
 * Message templates.
 *
 * What the boutique says to a customer, in the customer's language, with the
 * booking's actual figures filled in.
 *
 * ## The rule that shapes everything here
 *
 * **A variable with no value must never reach a customer.** `undefined`, `null`
 * and `NaN` are the three strings that turn a careful message into evidence
 * that the shop's system is broken, and they are exactly what naive
 * substitution produces. So rendering is a two-step operation: `missingVariables`
 * reports what cannot be filled, and the interface refuses to prepare the
 * message until they are resolved.
 *
 * There is no fallback to an empty string for a *required* variable. "Your
 * balance is  " is worse than a refusal, because the employee sends it.
 *
 * ## Bilingual is a structure, not a concatenation
 *
 * A bilingual message is the Arabic text, a separator line, then the English —
 * each as a coherent whole. Interleaving them sentence by sentence produces
 * something neither reader can follow, and simply gluing two paragraphs
 * together with no break reads as one corrupted message.
 *
 * Pure: no I/O, no Firebase, no clock. The values are a parameter.
 */

/* ------------------------------------------------------------------------ *
 * Template kinds
 * ------------------------------------------------------------------------ */

/**
 * The occasions the boutique writes to a customer about.
 *
 * A closed set. An employee may edit the wording of any of these; they may not
 * invent a new kind, because each is wired to a place in the interface that
 * knows which variables it can supply.
 */
export const TEMPLATE_KINDS = [
  'reservationConfirmation',
  'fittingReminder',
  'pickupReminder',
  'returnReminder',
  'overdueReturn',
  'balanceDue',
  'depositRefund',
  'waitlistAvailable',
  'paymentConfirmation',
] as const;

export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export function isTemplateKind(value: unknown): value is TemplateKind {
  return typeof value === 'string' && (TEMPLATE_KINDS as readonly string[]).includes(value);
}

/**
 * The language a single message is written in.
 *
 * Distinct from the *interface* language: an Arabic-speaking employee writes to
 * an English-speaking bride in English.
 */
export const MESSAGE_LANGUAGES = ['en', 'ar', 'bilingual'] as const;
export type MessageLanguage = (typeof MESSAGE_LANGUAGES)[number];

export function isMessageLanguage(value: unknown): value is MessageLanguage {
  return value === 'en' || value === 'ar' || value === 'bilingual';
}

/* ------------------------------------------------------------------------ *
 * Variables
 * ------------------------------------------------------------------------ */

/**
 * Every variable a template may reference.
 *
 * Closed, so a typo in a template is a detectable error rather than a literal
 * `{custmer_name}` arriving on somebody's phone.
 */
export const TEMPLATE_VARIABLES = [
  'customer_name',
  'customer_name_ar',
  'dress_name',
  'dress_code',
  'reservation_number',
  'invoice_number',
  'event_date',
  'pickup_date',
  'return_date',
  'balance',
  'total',
  'paid',
  'deposit',
  'business_name',
  'business_phone',
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export function isTemplateVariable(value: string): value is TemplateVariable {
  return (TEMPLATE_VARIABLES as readonly string[]).includes(value);
}

/**
 * The values available for one message.
 *
 * A variable is **absent** (not present, or an empty string) rather than
 * defaulted. Absence is information: it means the interface must not let this
 * message be prepared yet.
 */
export type TemplateValues = Partial<Record<TemplateVariable, string>>;

/** `{variable_name}`, with the braces. */
const PLACEHOLDER = /\{([a-z_]+)\}/g;

/**
 * Every variable a body references, in order of first appearance.
 *
 * Unknown names are returned too, as strings, so the template editor can warn
 * about `{custmer_name}` instead of silently leaving it in the message.
 */
export function variablesIn(body: string): string[] {
  const found: string[] = [];

  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined && !found.includes(name)) found.push(name);
  }

  return found;
}

/** Referenced names that are not variables at all — a typo in the template. */
export function unknownVariablesIn(body: string): string[] {
  return variablesIn(body).filter((name) => !isTemplateVariable(name));
}

/**
 * Variables the template needs and the data cannot supply.
 *
 * **The gate.** An empty result means the message can be prepared; anything
 * else means it must not be, and the interface names what is missing.
 *
 * An empty-string value counts as missing: a customer with no recorded event
 * date has no event date, and "your event on  " is not a message anybody should
 * send.
 */
export function missingVariables(body: string, values: TemplateValues): TemplateVariable[] {
  return variablesIn(body)
    .filter(isTemplateVariable)
    .filter((name) => {
      const value = values[name];
      return value === undefined || value.trim().length === 0;
    });
}

/**
 * Substitute values into a body.
 *
 * @throws never. A variable with no value is left as its own placeholder rather
 *         than becoming `undefined` — visible, obviously wrong, and impossible
 *         to mistake for prose. Callers must still check `missingVariables`
 *         first; this is the last line of defence, not the check.
 */
export function render(body: string, values: TemplateValues): string {
  return body.replace(PLACEHOLDER, (whole, name: string) =>
    isTemplateVariable(name) ? (values[name] ?? whole) : whole,
  );
}

/* ------------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------------ */

/**
 * One editable template.
 *
 * Both language bodies are stored whatever the boutique currently uses, so
 * switching a customer to Arabic does not require rewriting anything.
 */
export interface MessageTemplate {
  readonly kind: TemplateKind;
  readonly en: string;
  readonly ar: string;
  /** Disabled templates are not offered in the composer. */
  readonly enabled: boolean;
}

/**
 * The separator between the two halves of a bilingual message.
 *
 * A blank line, a short rule, a blank line. WhatsApp preserves newlines, so
 * this survives the trip; without it the two languages run together and read as
 * one corrupted message.
 */
export const BILINGUAL_SEPARATOR = '\n\n—\n\n';

/**
 * Compose the body for a language.
 *
 * Arabic first in the bilingual form. The boutique is in Oman and most
 * customers read Arabic; the first thing on the screen should be the thing most
 * of them can read.
 */
export function bodyFor(template: MessageTemplate, language: MessageLanguage): string {
  if (language === 'en') return template.en;
  if (language === 'ar') return template.ar;

  const parts = [template.ar.trim(), template.en.trim()].filter((part) => part.length > 0);

  return parts.join(BILINGUAL_SEPARATOR);
}

export interface PreparedMessage {
  readonly text: string;
  readonly language: MessageLanguage;
  readonly kind: TemplateKind;
  readonly missing: readonly TemplateVariable[];
  /** False when anything is missing. The composer refuses to proceed. */
  readonly ready: boolean;
}

/**
 * Prepare a message: choose the body, check it, render it.
 *
 * Returns the rendered text **even when incomplete**, so the composer can show
 * a preview with the gaps visible as placeholders while it refuses the send.
 * Showing nothing would leave the employee guessing what is wrong.
 */
export function prepare(input: {
  readonly template: MessageTemplate;
  readonly language: MessageLanguage;
  readonly values: TemplateValues;
}): PreparedMessage {
  const body = bodyFor(input.template, input.language);
  const missing = missingVariables(body, input.values);

  return {
    text: render(body, input.values),
    language: input.language,
    kind: input.template.kind,
    missing,
    ready: missing.length === 0 && body.trim().length > 0,
  };
}

/**
 * A blank template set.
 *
 * **No wording is supplied**, in either language, for the same reason the terms
 * editor ships empty: a message the boutique never wrote should not go out over
 * its name. The owner writes the words; this only says which occasions exist.
 */
export function emptyTemplates(): MessageTemplate[] {
  return TEMPLATE_KINDS.map((kind) => ({ kind, en: '', ar: '', enabled: true }));
}

/**
 * Merge stored templates over the blank set.
 *
 * A template kind added in a later release appears as blank rather than
 * missing, so the settings screen lists it and the composer refuses it until it
 * is written.
 */
export function mergeTemplates(stored: readonly Partial<MessageTemplate>[]): MessageTemplate[] {
  return emptyTemplates().map((blank) => {
    const found = stored.find((entry) => entry.kind === blank.kind);
    if (found === undefined) return blank;

    return {
      kind: blank.kind,
      en: typeof found.en === 'string' ? found.en : '',
      ar: typeof found.ar === 'string' ? found.ar : '',
      enabled: found.enabled !== false,
    };
  });
}

/**
 * Realistic values for the settings preview.
 *
 * Deliberately obvious as samples — "Sample Boutique", not a real business
 * name — so nobody mistakes a preview for a record. **Nothing here is written
 * anywhere**; the preview is a pure function of the template and these values.
 */
export const SAMPLE_VALUES: Readonly<Record<TemplateVariable, string>> = {
  customer_name: 'Sample Customer',
  customer_name_ar: 'عميلة تجريبية',
  dress_name: 'Sample Gown',
  dress_code: 'WD-0001',
  reservation_number: 'RSV-0001',
  invoice_number: 'INV-2026-0001',
  event_date: '12 September 2026',
  pickup_date: '10 September 2026',
  return_date: '14 September 2026',
  balance: 'OMR 120.000',
  total: 'OMR 420.000',
  paid: 'OMR 300.000',
  deposit: 'OMR 100.000',
  business_name: 'Sample Boutique',
  business_phone: '+968 9123 4567',
};
