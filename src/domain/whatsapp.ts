/**
 * WhatsApp click-to-chat.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This builds a `wa.me` link. Opening it hands the employee a WhatsApp window
 * with the message already typed. **The employee then presses send, or does
 * not.** The application never transmits anything and has no way of learning
 * what happened next.
 *
 * That is why nothing in this module — or anywhere downstream of it — may use
 * the words *sent*, *delivered* or *read*. The states are `Prepared`, `Opened`
 * and `Copied`, and each is literally true of something the application
 * observed. A log claiming a message was delivered, when all that happened was
 * a link opening, is a record that will one day be quoted back to a customer
 * who never received it.
 *
 * The WhatsApp Business API would change this. It is deliberately not here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ENCODING
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The message contains a customer's name, a booking code and money, and it goes
 * into a URL. `encodeURIComponent` is applied to the whole body — not a
 * hand-rolled replace of a few characters — because the failure mode of getting
 * that wrong is a truncated or mangled message shown to a customer, and in the
 * worst case a `&` that turns the rest of the message into query parameters.
 *
 * Pure: no I/O, no `window`, no clock.
 */

import { parseOmanPhone } from './phone';

/** The one host. Kept here so no call site hand-builds a URL. */
const WA_HOST = 'https://wa.me';

/**
 * WhatsApp caps a click-to-chat URL. Longer messages are refused rather than
 * silently truncated: half a message about a balance is worse than none.
 */
export const MAX_MESSAGE_LENGTH = 4000;

export type WhatsAppProblem =
  | 'NO_PHONE'
  | 'INVALID_PHONE'
  | 'EMPTY_MESSAGE'
  | 'MESSAGE_TOO_LONG';

export const WHATSAPP_PROBLEM_MESSAGES: Readonly<Record<WhatsAppProblem, string>> = {
  NO_PHONE: 'This customer has no phone number recorded.',
  INVALID_PHONE: 'This customer’s phone number is not a valid Oman number.',
  EMPTY_MESSAGE: 'There is nothing to send.',
  MESSAGE_TOO_LONG: `A WhatsApp message cannot exceed ${String(MAX_MESSAGE_LENGTH)} characters.`,
};

export type WhatsAppLink =
  | { readonly ok: true; readonly url: string; readonly phone: string }
  | { readonly ok: false; readonly problem: WhatsAppProblem };

/**
 * Build a click-to-chat link.
 *
 * The number goes through the **one** phone normaliser (`parseOmanPhone`), the
 * same one customer records and duplicate detection use. `wa.me` wants digits
 * with the country code and no `+`, which is exactly `ParsedPhone.normalized`.
 * Reimplementing that here would be a second definition of a valid number, and
 * the two would eventually disagree about somebody's contact details.
 */
export function buildWhatsAppLink(input: {
  readonly phone: string;
  readonly message: string;
}): WhatsAppLink {
  if (input.phone.trim().length === 0) {
    return { ok: false, problem: 'NO_PHONE' };
  }

  const parsed = parseOmanPhone(input.phone);

  if (!parsed.ok) {
    return { ok: false, problem: 'INVALID_PHONE' };
  }

  const message = input.message.trim();

  if (message.length === 0) {
    return { ok: false, problem: 'EMPTY_MESSAGE' };
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, problem: 'MESSAGE_TOO_LONG' };
  }

  /*
   * `encodeURIComponent` on the whole body. Newlines become %0A, Arabic becomes
   * percent-encoded UTF-8, and an `&` in a business name cannot escape into the
   * query string.
   */
  return {
    ok: true,
    url: `${WA_HOST}/${parsed.phone.normalized}?text=${encodeURIComponent(message)}`,
    phone: parsed.phone.normalized,
  };
}

/**
 * Can this customer be messaged at all?
 *
 * Used to decide whether the WhatsApp control renders. A button that always
 * fails is worse than no button: it teaches staff that the feature is broken.
 */
export function canMessage(phone: string): boolean {
  return phone.trim().length > 0 && parseOmanPhone(phone).ok;
}

/* ------------------------------------------------------------------------ *
 * Communication states
 * ------------------------------------------------------------------------ */

/**
 * What the application actually observed.
 *
 * - `Prepared` — a message was composed and logged. Nothing left the device.
 * - `Opened` — the employee opened the WhatsApp link. WhatsApp received the
 *   draft; whether it was sent is unknown.
 * - `Copied` — the employee copied the text to the clipboard.
 *
 * There is no `Sent`, no `Delivered`, no `Read`, and adding one requires an
 * actual API integration that can observe it.
 */
export const COMMUNICATION_STATUSES = ['Prepared', 'Opened', 'Copied'] as const;
export type CommunicationStatus = (typeof COMMUNICATION_STATUSES)[number];

export function isCommunicationStatus(value: unknown): value is CommunicationStatus {
  return value === 'Prepared' || value === 'Opened' || value === 'Copied';
}

/**
 * The only channel V1 has.
 *
 * Named rather than assumed, so the log records what was used and a second
 * channel later does not silently reinterpret every historical record.
 */
export const COMMUNICATION_CHANNELS = ['WhatsApp'] as const;
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

/**
 * Does this status describe an action the employee deliberately took?
 *
 * `Prepared` happens as a side effect of opening the composer; the other two
 * require a click. The distinction matters for §10: refreshing a page must not
 * look like a second attempt to contact somebody.
 */
export function isDeliberateAction(status: CommunicationStatus): boolean {
  return status === 'Opened' || status === 'Copied';
}
