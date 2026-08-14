import { describe, expect, it } from 'vitest';

import {
  bodyFor,
  emptyTemplates,
  mergeTemplates,
  missingVariables,
  prepare,
  render,
  unknownVariablesIn,
  variablesIn,
  BILINGUAL_SEPARATOR,
  SAMPLE_VALUES,
  TEMPLATE_KINDS,
  type MessageTemplate,
} from './message-template';

const template = (overrides: Partial<MessageTemplate> = {}): MessageTemplate => ({
  kind: 'pickupReminder',
  en: 'Hello {customer_name}, your gown is ready on {pickup_date}.',
  ar: 'مرحبا {customer_name_ar}، فستانك جاهز في {pickup_date}.',
  enabled: true,
  ...overrides,
});

/* ------------------------------------------------------------------------ *
 * The rule that shapes everything
 * ------------------------------------------------------------------------ */

describe('a variable with no value', () => {
  it('NEVER renders as undefined, null or NaN', () => {
    /*
     * Load-bearing. These three strings are exactly what naive substitution
     * produces, and each turns a careful message into evidence that the shop's
     * system is broken.
     */
    const text = render('Hello {customer_name}, you owe {balance}.', {});

    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
    expect(text).not.toContain('NaN');
  });

  it('is left as its own placeholder — visible and obviously wrong', () => {
    expect(render('Hello {customer_name}.', {})).toBe('Hello {customer_name}.');
  });

  it('is reported by missingVariables so the composer can refuse', () => {
    const missing = missingVariables('Hi {customer_name}, you owe {balance}.', {
      customer_name: 'Fatima',
    });

    expect(missing).toEqual(['balance']);
  });

  it('treats an EMPTY STRING as missing, not as a value', () => {
    // "Your event on  " is not a message anybody should send.
    expect(missingVariables('Event: {event_date}', { event_date: '' })).toEqual(['event_date']);
    expect(missingVariables('Event: {event_date}', { event_date: '   ' })).toEqual(['event_date']);
  });

  it('accepts a value of "0" — a real balance of zero is not missing', () => {
    expect(missingVariables('Balance {balance}', { balance: 'OMR 0.000' })).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * Finding variables
 * ------------------------------------------------------------------------ */

describe('reading a template', () => {
  it('lists the variables it references, in order, without repeats', () => {
    expect(variablesIn('{customer_name} — {balance} — {customer_name}')).toEqual([
      'customer_name',
      'balance',
    ]);
  });

  it('finds nothing in a template with no variables', () => {
    expect(variablesIn('Your dress is ready.')).toEqual([]);
  });

  it('reports a TYPO as an unknown variable rather than leaving it in silently', () => {
    // `{custmer_name}` would otherwise arrive verbatim on somebody's phone.
    expect(unknownVariablesIn('Hi {custmer_name}')).toEqual(['custmer_name']);
    expect(unknownVariablesIn('Hi {customer_name}')).toEqual([]);
  });

  it('does not treat an unknown name as missing data', () => {
    // A typo is a template defect, not an absent value; conflating them would
    // make the composer demand data that no field can supply.
    expect(missingVariables('Hi {custmer_name}', {})).toEqual([]);
  });

  it('leaves an unknown placeholder untouched when rendering', () => {
    expect(render('Hi {custmer_name}', { customer_name: 'Fatima' })).toBe('Hi {custmer_name}');
  });

  it('ignores braces that are not placeholders', () => {
    expect(variablesIn('Opening hours {9-5} and {}')).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------------ */

describe('rendering', () => {
  it('substitutes every occurrence', () => {
    expect(render('{customer_name} and {customer_name}', { customer_name: 'Fatima' })).toBe(
      'Fatima and Fatima',
    );
  });

  it('renders Arabic values into an Arabic body', () => {
    const text = render('مرحبا {customer_name_ar}', { customer_name_ar: 'فاطمة' });

    expect(text).toBe('مرحبا فاطمة');
  });

  it('does not re-expand a value that itself looks like a placeholder', () => {
    // A customer legitimately named "{balance}" must not become their balance.
    expect(render('Hi {customer_name}', { customer_name: '{balance}', balance: 'OMR 5' })).toBe(
      'Hi {balance}',
    );
  });
});

/* ------------------------------------------------------------------------ *
 * Bilingual structure
 * ------------------------------------------------------------------------ */

describe('a bilingual message', () => {
  it('is Arabic, a separator, then English — not two paragraphs glued together', () => {
    const body = bodyFor(template(), 'bilingual');

    expect(body).toContain(BILINGUAL_SEPARATOR);
    expect(body.indexOf('مرحبا')).toBeLessThan(body.indexOf('Hello'));
  });

  it('puts Arabic first, because most of the boutique’s customers read it', () => {
    expect(bodyFor(template(), 'bilingual').startsWith('مرحبا')).toBe(true);
  });

  it('omits the separator when only one language is written', () => {
    const onlyEnglish = bodyFor(template({ ar: '' }), 'bilingual');

    expect(onlyEnglish).not.toContain(BILINGUAL_SEPARATOR);
    expect(onlyEnglish).toBe(template().en);
  });

  it('is empty when neither language is written', () => {
    expect(bodyFor(template({ en: '', ar: '' }), 'bilingual')).toBe('');
  });

  it('uses only the requested language when not bilingual', () => {
    expect(bodyFor(template(), 'en')).toBe(template().en);
    expect(bodyFor(template(), 'ar')).toBe(template().ar);
  });
});

/* ------------------------------------------------------------------------ *
 * Preparing
 * ------------------------------------------------------------------------ */

describe('preparing a message', () => {
  const values = {
    customer_name: 'Fatima',
    customer_name_ar: 'فاطمة',
    pickup_date: '10 September 2026',
  };

  it('is ready when every variable is supplied', () => {
    const prepared = prepare({ template: template(), language: 'en', values });

    expect(prepared.ready).toBe(true);
    expect(prepared.missing).toEqual([]);
    expect(prepared.text).toBe('Hello Fatima, your gown is ready on 10 September 2026.');
  });

  it('is NOT ready when anything is missing', () => {
    const prepared = prepare({ template: template(), language: 'en', values: {} });

    expect(prepared.ready).toBe(false);
    expect(prepared.missing).toContain('customer_name');
  });

  it('still returns the text when incomplete, so the gap is visible', () => {
    // Showing nothing would leave the employee guessing what is wrong.
    const prepared = prepare({ template: template(), language: 'en', values: {} });

    expect(prepared.text).toContain('{customer_name}');
  });

  it('is NOT ready for a template nobody has written yet', () => {
    const prepared = prepare({ template: template({ en: '   ' }), language: 'en', values });

    expect(prepared.ready).toBe(false);
  });

  it('checks the BILINGUAL body, so a gap in either language blocks it', () => {
    const prepared = prepare({
      template: template(),
      language: 'bilingual',
      // The English half needs customer_name; the Arabic half needs the Arabic one.
      values: { customer_name: 'Fatima', pickup_date: '10 September 2026' },
    });

    expect(prepared.ready).toBe(false);
    expect(prepared.missing).toContain('customer_name_ar');
  });

  it('carries the kind and language through, for the log', () => {
    const prepared = prepare({ template: template(), language: 'ar', values });

    expect(prepared.kind).toBe('pickupReminder');
    expect(prepared.language).toBe('ar');
  });
});

/* ------------------------------------------------------------------------ *
 * The template set
 * ------------------------------------------------------------------------ */

describe('the template set', () => {
  it('supplies NO wording, in either language', () => {
    /*
     * The same principle as the terms editor: a message the boutique never
     * wrote should not go out over its name.
     */
    for (const entry of emptyTemplates()) {
      expect(entry.en).toBe('');
      expect(entry.ar).toBe('');
    }
  });

  it('covers every occasion the specification names', () => {
    expect(emptyTemplates()).toHaveLength(TEMPLATE_KINDS.length);
    expect([...TEMPLATE_KINDS]).toEqual([
      'reservationConfirmation',
      'fittingReminder',
      'pickupReminder',
      'returnReminder',
      'overdueReturn',
      'balanceDue',
      'depositRefund',
      'waitlistAvailable',
      'paymentConfirmation',
    ]);
  });

  it('merges stored wording over the blank set', () => {
    const merged = mergeTemplates([{ kind: 'balanceDue', en: 'You owe {balance}.' }]);
    const balance = merged.find((entry) => entry.kind === 'balanceDue');

    expect(balance?.en).toBe('You owe {balance}.');
    expect(balance?.ar).toBe('');
  });

  it('shows a NEWLY ADDED kind as blank rather than dropping it', () => {
    // A template kind added in a later release must appear in settings.
    const merged = mergeTemplates([{ kind: 'balanceDue', en: 'x' }]);

    expect(merged).toHaveLength(TEMPLATE_KINDS.length);
  });

  it('ignores a stored entry for a kind that no longer exists', () => {
    const merged = mergeTemplates([{ kind: 'obsolete' as never, en: 'x' }]);

    expect(merged.every((entry) => entry.en === '')).toBe(true);
  });

  it('treats a missing enabled flag as enabled', () => {
    const merged = mergeTemplates([{ kind: 'balanceDue', en: 'x' }]);

    expect(merged.find((entry) => entry.kind === 'balanceDue')?.enabled).toBe(true);
  });

  it('honours an explicit disable', () => {
    const merged = mergeTemplates([{ kind: 'balanceDue', en: 'x', enabled: false }]);

    expect(merged.find((entry) => entry.kind === 'balanceDue')?.enabled).toBe(false);
  });
});

describe('the preview samples', () => {
  it('supply every variable, so a preview never shows a gap', () => {
    const body = Object.keys(SAMPLE_VALUES)
      .map((name) => `{${name}}`)
      .join(' ');

    expect(missingVariables(body, SAMPLE_VALUES)).toEqual([]);
  });

  it('are obviously samples, so nobody mistakes a preview for a record', () => {
    expect(SAMPLE_VALUES.business_name).toContain('Sample');
    expect(SAMPLE_VALUES.customer_name).toContain('Sample');
  });
});
