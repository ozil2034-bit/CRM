import { describe, expect, it } from 'vitest';

import {
  emptyTermsSections,
  isPublishable,
  isTermsSectionKey,
  missingSections,
  parseTermsSnapshot,
  printableSections,
  snapshotTerms,
  TERMS_SECTION_KEYS,
} from './terms';
import type { TermsSection } from './document';

function section(overrides: Partial<TermsSection> = {}): TermsSection {
  return {
    key: 'damageAndLoss',
    titleEn: 'Damage and loss',
    titleAr: 'التلف والفقد',
    bodyEn: 'The customer is responsible for the gown while it is in their care.',
    bodyAr: 'العميلة مسؤولة عن الفستان أثناء وجوده في عهدتها.',
    ...overrides,
  };
}

describe('the section list', () => {
  it('covers every topic the specification names', () => {
    expect([...TERMS_SECTION_KEYS]).toEqual([
      'damageAndLoss',
      'lateReturn',
      'cancellationAndRefund',
      'alterations',
      'securityDeposit',
      'hygieneAndCleaning',
    ]);
  });

  it('recognises its own keys and nothing else', () => {
    for (const key of TERMS_SECTION_KEYS) expect(isTermsSectionKey(key)).toBe(true);
    expect(isTermsSectionKey('refundPolicy')).toBe(false);
  });
});

describe('the starting point for the editor', () => {
  it('supplies one blank section per topic', () => {
    const sections = emptyTermsSections();

    expect(sections).toHaveLength(TERMS_SECTION_KEYS.length);
    expect(sections.map((entry) => entry.key)).toEqual([...TERMS_SECTION_KEYS]);
  });

  it('supplies NO legal text — the boutique writes its own', () => {
    /*
     * Load-bearing. Shipping default wording about liability, cancellation
     * rights or hygiene would put claims in front of a customer that the
     * boutique never made and may not be able to defend.
     */
    for (const entry of emptyTermsSections()) {
      expect(entry.titleEn).toBe('');
      expect(entry.titleAr).toBe('');
      expect(entry.bodyEn).toBe('');
      expect(entry.bodyAr).toBe('');
    }
  });

  it('is not publishable while empty', () => {
    expect(isPublishable(emptyTermsSections())).toBe(false);
  });
});

describe('what gets printed', () => {
  it('drops sections with nothing in them', () => {
    const sections = [section(), ...emptyTermsSections().slice(1)];

    expect(printableSections(sections)).toHaveLength(1);
  });

  it('keeps a section written in only one language', () => {
    // A boutique may add the Arabic later; the English clause still applies.
    const sections = [section({ bodyAr: '', titleAr: '' })];

    expect(printableSections(sections)).toHaveLength(1);
  });

  it('treats whitespace as empty', () => {
    const sections = [section({ titleEn: '  ', titleAr: '', bodyEn: '\n', bodyAr: '  ' })];

    expect(printableSections(sections)).toHaveLength(0);
  });

  it('becomes publishable once one section has content', () => {
    expect(isPublishable([section()])).toBe(true);
  });
});

describe('reporting what is still unwritten', () => {
  it('names every missing section, per language', () => {
    const result = missingSections([section()]);

    expect(result.en).not.toContain('damageAndLoss');
    expect(result.ar).not.toContain('damageAndLoss');
    expect(result.en).toContain('lateReturn');
    expect(result.ar).toContain('lateReturn');
  });

  it('reports a set complete in English but not Arabic', () => {
    const sections = TERMS_SECTION_KEYS.map((key) => section({ key, bodyAr: '' }));
    const result = missingSections(sections);

    expect(result.en).toEqual([]);
    expect(result.ar).toEqual([...TERMS_SECTION_KEYS]);
  });

  it('reports everything missing for an empty set', () => {
    const result = missingSections([]);

    expect(result.en).toEqual([...TERMS_SECTION_KEYS]);
    expect(result.ar).toEqual([...TERMS_SECTION_KEYS]);
  });
});

describe('freezing terms onto a document', () => {
  it('copies the full text, not a reference', () => {
    // A reference would let a later edit change what a customer had signed.
    const sections = [section()];
    const snapshot = snapshotTerms('v-1', 'Version 1', sections);

    expect(snapshot.sections[0]!.bodyEn).toBe(sections[0]!.bodyEn);
    expect(snapshot.sections[0]).not.toBe(sections[0]);
  });

  it('records the version so a dispute can be traced to the wording that applied', () => {
    const snapshot = snapshotTerms('v-7', 'Autumn 2026', [section()]);

    expect(snapshot.versionId).toBe('v-7');
    expect(snapshot.versionLabel).toBe('Autumn 2026');
  });

  it('omits blank sections from the frozen copy', () => {
    const snapshot = snapshotTerms('v-1', '', [section(), ...emptyTermsSections()]);

    expect(snapshot.sections).toHaveLength(1);
  });

  it('is unaffected by later edits to the source array', () => {
    const sections = [section()];
    const snapshot = snapshotTerms('v-1', '', sections);

    sections[0] = section({ bodyEn: 'Rewritten after the fact' });

    expect(snapshot.sections[0]!.bodyEn).toMatch(/responsible for the gown/);
  });
});

describe('restoring a stored snapshot', () => {
  it('round-trips', () => {
    const snapshot = snapshotTerms('v-1', 'Version 1', [section()]);

    expect(parseTermsSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it('refuses malformed data rather than guessing', () => {
    expect(parseTermsSnapshot(null)).toBeNull();
    expect(parseTermsSnapshot({})).toBeNull();
    expect(parseTermsSnapshot({ versionId: 'v-1' })).toBeNull();
    expect(parseTermsSnapshot({ sections: [] })).toBeNull();
  });

  it('tolerates a partially-formed section rather than losing the whole version', () => {
    const restored = parseTermsSnapshot({
      versionId: 'v-1',
      sections: [{ key: 'lateReturn', bodyEn: 'Text' }],
    });

    expect(restored?.sections[0]).toEqual({
      key: 'lateReturn',
      titleEn: '',
      titleAr: '',
      bodyEn: 'Text',
      bodyAr: '',
    });
  });
});
