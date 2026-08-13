/**
 * Terms and conditions.
 *
 * The boutique writes its own terms. This module provides the **structure** —
 * which topics a complete set of terms covers, and how a version is frozen onto
 * a document — and deliberately provides **no legal text**.
 *
 * That is a firm line. Shipping default wording about damage liability,
 * cancellation rights or hygiene would put claims in front of a customer that
 * the boutique never made and may not be able to defend. The topics below are
 * empty prompts for the owner to fill; a section left blank is simply not
 * printed.
 *
 * Pure: no I/O, no clock.
 */

import type { TermsSection, TermsSnapshot } from './document';

/**
 * The topics a complete set of terms covers.
 *
 * Ordered as they should appear on a contract: what the customer is
 * responsible for, then what it costs if something goes wrong, then how the
 * agreement can end.
 */
export const TERMS_SECTION_KEYS = [
  'damageAndLoss',
  'lateReturn',
  'cancellationAndRefund',
  'alterations',
  'securityDeposit',
  'hygieneAndCleaning',
] as const;

export type TermsSectionKey = (typeof TERMS_SECTION_KEYS)[number];

export function isTermsSectionKey(value: unknown): value is TermsSectionKey {
  return typeof value === 'string' && (TERMS_SECTION_KEYS as readonly string[]).includes(value);
}

/**
 * An empty set of sections, for the settings editor to populate.
 *
 * Titles and bodies are blank. **No default legal text is supplied** — see the
 * module note. The owner writes both languages.
 */
export function emptyTermsSections(): TermsSection[] {
  return TERMS_SECTION_KEYS.map((key) => ({
    key,
    titleEn: '',
    titleAr: '',
    bodyEn: '',
    bodyAr: '',
  }));
}

/** Sections with something to say. A blank section is not printed. */
export function printableSections(sections: readonly TermsSection[]): TermsSection[] {
  return sections.filter(
    (section) =>
      section.bodyEn.trim().length > 0 ||
      section.bodyAr.trim().length > 0 ||
      section.titleEn.trim().length > 0 ||
      section.titleAr.trim().length > 0,
  );
}

/**
 * Is this version usable on a document?
 *
 * A version with no printable section would put a heading with nothing under it
 * on a contract, which is worse than omitting the terms entirely and being
 * visibly incomplete.
 */
export function isPublishable(sections: readonly TermsSection[]): boolean {
  return printableSections(sections).length > 0;
}

/**
 * Which sections are still unwritten, so the settings screen can say so.
 *
 * Reported per language: a boutique serving Arabic-speaking brides needs the
 * Arabic column filled, and a set that is complete in English only will produce
 * a bilingual contract with gaps.
 */
export function missingSections(sections: readonly TermsSection[]): {
  readonly en: TermsSectionKey[];
  readonly ar: TermsSectionKey[];
} {
  const en: TermsSectionKey[] = [];
  const ar: TermsSectionKey[] = [];

  for (const key of TERMS_SECTION_KEYS) {
    const section = sections.find((candidate) => candidate.key === key);

    if (section === undefined || section.bodyEn.trim().length === 0) en.push(key);
    if (section === undefined || section.bodyAr.trim().length === 0) ar.push(key);
  }

  return { en, ar };
}

/**
 * Freeze a terms version onto a document.
 *
 * The full text is copied, not referenced. A reference would let a later edit
 * change what a customer had already signed — and the whole reason terms are
 * versioned is that they must not.
 */
export function snapshotTerms(
  versionId: string,
  versionLabel: string,
  sections: readonly TermsSection[],
): TermsSnapshot {
  return {
    versionId,
    versionLabel,
    sections: printableSections(sections).map((section) => ({ ...section })),
  };
}

/** Restore a stored snapshot, validating rather than trusting it. */
export function parseTermsSnapshot(value: unknown): TermsSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;
  const sections = record['sections'];

  if (typeof record['versionId'] !== 'string' || !Array.isArray(sections)) return null;

  return {
    versionId: record['versionId'],
    versionLabel: typeof record['versionLabel'] === 'string' ? record['versionLabel'] : '',
    sections: sections.flatMap((entry): TermsSection[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const section = entry as Record<string, unknown>;

      return [
        {
          key: String(section['key'] ?? ''),
          titleEn: String(section['titleEn'] ?? ''),
          titleAr: String(section['titleAr'] ?? ''),
          bodyEn: String(section['bodyEn'] ?? ''),
          bodyAr: String(section['bodyAr'] ?? ''),
        },
      ];
    }),
  };
}
