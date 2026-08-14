import { describe, expect, it } from 'vitest';

import {
  buildWhatsAppLink,
  canMessage,
  isCommunicationStatus,
  isDeliberateAction,
  COMMUNICATION_STATUSES,
  MAX_MESSAGE_LENGTH,
} from './whatsapp';

const ok = (result: ReturnType<typeof buildWhatsAppLink>) => {
  if (!result.ok) throw new Error(`expected a link, got ${result.problem}`);
  return result;
};

describe('the states this application is entitled to record', () => {
  it('has NO sent, delivered or read state', () => {
    /*
     * Load-bearing, and the reason the whole module exists in this shape. The
     * application opens a link; it never transmits anything and cannot observe
     * what happened next. A log claiming delivery is a record that will one day
     * be quoted back to a customer who never received the message.
     */
    expect([...COMMUNICATION_STATUSES]).toEqual(['Prepared', 'Opened', 'Copied']);

    for (const forbidden of ['Sent', 'Delivered', 'Read', 'Failed']) {
      expect(isCommunicationStatus(forbidden)).toBe(false);
    }
  });

  it('separates a deliberate action from a side effect', () => {
    // Preparing happens when the composer opens; the other two need a click.
    expect(isDeliberateAction('Prepared')).toBe(false);
    expect(isDeliberateAction('Opened')).toBe(true);
    expect(isDeliberateAction('Copied')).toBe(true);
  });
});

describe('building a click-to-chat link', () => {
  it('uses the international form with no plus, as wa.me requires', () => {
    const result = ok(buildWhatsAppLink({ phone: '91234567', message: 'Hello' }));

    expect(result.url.startsWith('https://wa.me/96891234567?text=')).toBe(true);
    expect(result.phone).toBe('96891234567');
  });

  it('accepts every form staff actually type, through the ONE normaliser', () => {
    const forms = ['91234567', '+968 9123 4567', '00968-91234567', '+96891234567'];

    for (const phone of forms) {
      expect(ok(buildWhatsAppLink({ phone, message: 'Hi' })).phone).toBe('96891234567');
    }
  });

  it('accepts Arabic-Indic digits, because the normaliser does', () => {
    expect(ok(buildWhatsAppLink({ phone: '٩١٢٣٤٥٦٧', message: 'Hi' })).phone).toBe('96891234567');
  });

  it('percent-encodes the whole message', () => {
    const result = ok(buildWhatsAppLink({ phone: '91234567', message: 'A & B' }));

    // A raw `&` would end the text parameter and drop the rest of the message.
    expect(result.url).toContain('A%20%26%20B');
    expect(result.url.split('?text=')[1]).not.toContain('&');
  });

  it('encodes newlines rather than losing the line breaks', () => {
    const result = ok(buildWhatsAppLink({ phone: '91234567', message: 'One\nTwo' }));

    expect(result.url).toContain('%0A');
  });

  it('encodes Arabic correctly', () => {
    const result = ok(buildWhatsAppLink({ phone: '91234567', message: 'مرحبا' }));

    expect(result.url).toContain('%D9%85');
    expect(decodeURIComponent(result.url.split('?text=')[1] ?? '')).toBe('مرحبا');
  });

  it('round-trips a message containing every awkward character', () => {
    const message = 'Fatima — OMR 120.000 & RSV-0001 #1 ?query +968 100%\nطرحة';
    const result = ok(buildWhatsAppLink({ phone: '91234567', message }));

    expect(decodeURIComponent(result.url.split('?text=')[1] ?? '')).toBe(message);
  });

  it('trims the message but keeps its internal shape', () => {
    const result = ok(buildWhatsAppLink({ phone: '91234567', message: '  Hi\n\nThere  ' }));

    expect(decodeURIComponent(result.url.split('?text=')[1] ?? '')).toBe('Hi\n\nThere');
  });
});

describe('refusing to build a link', () => {
  it('refuses an empty phone number', () => {
    const result = buildWhatsAppLink({ phone: '   ', message: 'Hi' });

    expect(result).toEqual({ ok: false, problem: 'NO_PHONE' });
  });

  it('refuses a number that is not a valid Oman number', () => {
    // 3x is not an assigned Omani subscriber prefix.
    const result = buildWhatsAppLink({ phone: '31234567', message: 'Hi' });

    expect(result).toEqual({ ok: false, problem: 'INVALID_PHONE' });
  });

  it('refuses a foreign number rather than building an unreachable link', () => {
    const result = buildWhatsAppLink({ phone: '+447700900000', message: 'Hi' });

    expect(result.ok).toBe(false);
  });

  it('refuses an empty message', () => {
    expect(buildWhatsAppLink({ phone: '91234567', message: '   ' })).toEqual({
      ok: false,
      problem: 'EMPTY_MESSAGE',
    });
  });

  it('refuses an over-long message rather than truncating it', () => {
    // Half a message about a balance is worse than none.
    const result = buildWhatsAppLink({
      phone: '91234567',
      message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1),
    });

    expect(result).toEqual({ ok: false, problem: 'MESSAGE_TOO_LONG' });
  });

  it('accepts a message at exactly the limit', () => {
    expect(
      buildWhatsAppLink({ phone: '91234567', message: 'x'.repeat(MAX_MESSAGE_LENGTH) }).ok,
    ).toBe(true);
  });
});

describe('whether to offer the control at all', () => {
  it('is false without a usable number, so no button that always fails renders', () => {
    expect(canMessage('')).toBe(false);
    expect(canMessage('   ')).toBe(false);
    expect(canMessage('31234567')).toBe(false);
    expect(canMessage('not a phone')).toBe(false);
  });

  it('is true for a valid Oman mobile and landline', () => {
    expect(canMessage('91234567')).toBe(true);
    expect(canMessage('24123456')).toBe(true);
  });
});
