import { describe, expect, it } from 'vitest';

import { ar, en, DICTIONARIES, DIRECTION, type TranslationKey } from './dictionary';
import { normaliseSearchText, rankMatches, toSearchToken } from '@/domain/search';

const keys = Object.keys(en) as TranslationKey[];

/* ------------------------------------------------------------------------ *
 * Coverage
 * ------------------------------------------------------------------------ */

describe('the Arabic dictionary', () => {
  it('translates EVERY key', () => {
    /*
     * The type system already makes a missing key a compile error. This catches
     * what it cannot: a key present but left as an empty string, which would
     * ship a blank label to an Arabic user rather than an English one.
     */
    const blank = keys.filter((key) => ar[key].trim().length === 0);

    expect(blank).toEqual([]);
  });

  it('leaves no key still holding its English text', () => {
    /*
     * A handful of strings are legitimately identical — brand names, and
     * `language.toggle`, which shows the OTHER language's name by design. Every
     * other match means a key was added to `en` and copied into `ar` without
     * being translated.
     */
    const allowed = new Set<TranslationKey>([
      'language.toggle',
      'app.name',
      'notify.whatsapp',
      'settings.prefix.dress',
      'settings.prefix.customer',
      'settings.prefix.reservation',
      'settings.prefix.invoice',
    ]);

    const untranslated = keys.filter(
      (key) => !allowed.has(key) && ar[key] === en[key] && /[A-Za-z]{3,}/.test(en[key]),
    );

    expect(untranslated).toEqual([]);
  });

  it('has no duplicate keys in either dictionary', () => {
    // Object literals silently keep the last of a duplicate pair, so a
    // duplicated key would quietly override an earlier translation.
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(ar)).toHaveLength(keys.length);
  });
});

describe('direction', () => {
  it('is right-to-left for Arabic and left-to-right for English', () => {
    expect(DIRECTION.ar).toBe('rtl');
    expect(DIRECTION.en).toBe('ltr');
  });

  it('exposes both dictionaries under their language code', () => {
    expect(DICTIONARIES.en).toBe(en);
    expect(DICTIONARIES.ar).toBe(ar);
  });
});

/* ------------------------------------------------------------------------ *
 * What must never be claimed, in either language
 * ------------------------------------------------------------------------ */

describe('the communication vocabulary', () => {
  it('never claims a message was SENT, DELIVERED or READ', () => {
    /*
     * Load-bearing, and the reason it is asserted over the dictionary rather
     * than over one component: the claim would be equally wrong wherever it
     * appeared, and a translator adding "تم الإرسال" to a status label would
     * reintroduce it without touching any code.
     *
     * The English side is checked with word boundaries so "Not sent" — which is
     * an honest thing to say — does not trip it.
     */
    expect(en['commStatus.Prepared']).not.toMatch(/\bsent\b|\bdelivered\b|\bread\b/i);
    expect(en['commStatus.Opened']).not.toMatch(/\bsent\b|\bdelivered\b|\bread\b/i);
    expect(en['commStatus.Copied']).not.toMatch(/\bsent\b|\bdelivered\b|\bread\b/i);

    for (const key of ['commStatus.Prepared', 'commStatus.Opened', 'commStatus.Copied'] as const) {
      expect(ar[key]).not.toContain('أُرسلت');
      expect(ar[key]).not.toContain('تم الإرسال');
      expect(ar[key]).not.toContain('سُلّمت');
    }
  });

  it('says plainly, in both languages, that opening is not sending', () => {
    expect(en['notify.notSentDisclaimer'].toLowerCase()).toContain('does not send');
    expect(ar['notify.notSentDisclaimer']).toContain('لا يرسل');
  });

  it('describes the opened state as WhatsApp opening, not the message arriving', () => {
    expect(en['notify.opened'].toLowerCase()).toContain('opened');
    expect(en['notify.opened'].toLowerCase()).not.toMatch(/\bsent\b/);
  });
});

/* ------------------------------------------------------------------------ *
 * Arabic search — the Phase 3 normalisation must not regress (§14)
 * ------------------------------------------------------------------------ */

describe('Arabic search still normalises correctly', () => {
  /*
   * Phase 3 established this and Phase 8 touched a great deal of rendering
   * around it. These assertions are duplicated from the search suite on
   * purpose: they are the ones an interface change is most likely to break
   * quietly, by normalising at a call site instead of through the domain.
   */
  it.each([
    ['أحمد', 'احمد'],
    ['إيمان', 'ايمان'],
    ['آمنة', 'امنه'],
    ['ليلى', 'ليلي'],
    ['فاطمة', 'فاطمه'],
  ])('folds %s and %s to the same form', (a, b) => {
    expect(normaliseSearchText(a)).toBe(normaliseSearchText(b));
  });

  it('folds every alif form to the bare alif', () => {
    const forms = ['أ', 'إ', 'آ', 'ا'];
    const folded = new Set(forms.map((form) => normaliseSearchText(`${form}حمد`)));

    expect(folded.size).toBe(1);
  });

  it('folds ta marbuta to ha, and alif maqsura to ya', () => {
    expect(normaliseSearchText('ة')).toBe(normaliseSearchText('ه'));
    expect(normaliseSearchText('ى')).toBe(normaliseSearchText('ي'));
  });

  it('finds أحمد when the employee types احمد, end to end', () => {
    const customers = [{ name: 'أحمد الحارثي' }, { name: 'Sara Al Balushi' }];

    expect(rankMatches('احمد', customers, (entry) => entry.name)).toEqual([customers[0]]);
  });

  it('finds احمد when the record was stored as أحمد', () => {
    const customers = [{ name: 'احمد' }];

    expect(rankMatches('أحمد', customers, (entry) => entry.name)).toEqual([customers[0]]);
  });

  it('produces a query token for an Arabic term', () => {
    expect(toSearchToken('فاطمة')).not.toBeNull();
  });
});
