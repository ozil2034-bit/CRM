/**
 * Business profile, logo and terms.
 *
 * Owner-only, enforced by the rules rather than by this screen. Everything here
 * decides what appears on every document the boutique issues, so the shop floor
 * must not be able to change it.
 *
 * Two things are deliberately awkward. Registration numbers may be left blank
 * and the hint says to leave them blank until the real number exists — a guessed
 * VAT number on a tax invoice is a false statement. And the terms editor starts
 * completely empty: no wording is supplied, because a claim the boutique never
 * made should never appear on a contract it asks a customer to sign.
 */

import { useCallback, useEffect, useState } from 'react';

import { Alert, Button, Field, TextArea } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import {
  emptyTermsSections,
  observeActiveTermsVersionId,
  observeBusinessProfile,
  observeTermsVersions,
  publishTermsVersion,
  refuseLogo,
  resolveStorageUrl,
  saveBusinessProfile,
  setActiveTermsVersion,
  uploadLogo,
  BusinessServiceError,
  EMPTY_BUSINESS,
  type TermsVersion,
} from '@/services/business.service';
import { missingSections, type TermsSectionKey } from '@/domain/terms';
import type { BusinessSnapshot, TermsSection } from '@/domain/document';
import { formatMuscat } from '@/domain/datetime';

export interface BusinessSettingsPageProps {
  /**
   * Which part to render.
   *
   * Phase 8 puts settings behind tabs, and the business profile and the terms
   * editor belong to different ones. They share state — the same save banner,
   * the same busy flag — so the component stays whole and renders a slice,
   * rather than being split into two that would each need their own copy.
   */
  readonly section?: 'business' | 'terms' | 'all';
  /** False when the tabbed shell already drew a page heading. */
  readonly withHeading?: boolean;
}

export function BusinessSettingsPage({
  section = 'all',
  withHeading = true,
}: BusinessSettingsPageProps = {}) {
  const { t, language } = useT();
  const { principal } = useAuth();

  const [profile, setProfile] = useState<BusinessSnapshot>(EMPTY_BUSINESS);
  const [draft, setDraft] = useState<BusinessSnapshot | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  const [versions, setVersions] = useState<TermsVersion[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sections, setSections] = useState<TermsSection[]>(() => emptyTermsSections());
  const [versionLabel, setVersionLabel] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => observeBusinessProfile(setProfile, (caught) => setError(caught.message)), []);
  useEffect(() => observeTermsVersions(setVersions, () => setVersions([])), []);
  useEffect(() => observeActiveTermsVersionId(setActiveId, () => setActiveId(null)), []);

  useEffect(() => {
    let cancelled = false;

    void resolveStorageUrl(profile.logoPath).then((url) => {
      if (!cancelled) setLogoUrl(url);
    });

    return () => {
      cancelled = true;
    };
  }, [profile.logoPath]);

  /*
   * The form edits a draft that starts from whatever was last loaded. Keying it
   * off the stored profile rather than resetting in an effect means a live
   * update from another device cannot silently discard what is being typed.
   */
  const values = draft ?? profile;

  const set = useCallback(
    <K extends keyof BusinessSnapshot>(field: K, value: BusinessSnapshot[K]) => {
      setDraft((current) => ({ ...(current ?? profile), [field]: value }));
    },
    [profile],
  );

  const save = useCallback(async () => {
    if (principal === null) return;

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      await saveBusinessProfile(values, principal.uid);
      setDraft(null);
      setNotice(t('settings.saved'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('error.loadFailed'));
    } finally {
      setBusy(false);
    }
  }, [values, principal, t]);

  const chooseLogo = useCallback(
    async (file: File) => {
      if (principal === null) return;

      const refusal = refuseLogo(file);
      if (refusal !== null) {
        setError(refusal);
        return;
      }

      setBusy(true);
      setError(null);

      try {
        await uploadLogo(file, principal.uid);
        setNotice(t('settings.saved'));
      } catch (caught) {
        setError(
          caught instanceof BusinessServiceError
            ? caught.message
            : caught instanceof Error
              ? caught.message
              : t('error.loadFailed'),
        );
      } finally {
        setBusy(false);
      }
    },
    [principal, t],
  );

  const publish = useCallback(async () => {
    if (principal === null) return;

    setBusy(true);
    setError(null);

    try {
      const id = await publishTermsVersion({
        label: versionLabel,
        sections,
        actorUid: principal.uid,
      });
      await setActiveTermsVersion(id, principal.uid);
      setNotice(t('settings.saved'));
    } catch (caught) {
      setError(
        caught instanceof BusinessServiceError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : t('error.loadFailed'),
      );
    } finally {
      setBusy(false);
    }
  }, [versionLabel, sections, principal, t]);

  const missing = missingSections(sections);

  return (
    <div className={withHeading ? 'mx-auto max-w-3xl px-6 py-10' : ''}>
      {withHeading && (
        <header>
          <p className="label-caps">{t('nav.settings')}</p>
          <h1 className="display mt-2 text-3xl text-ink-900">{t('settings.title')}</h1>
        </header>
      )}

      {error && (
        <Alert tone="error" className="mt-6">
          {error}
        </Alert>
      )}

      {notice && (
        <Alert tone="success" className="mt-6">
          {notice}
        </Alert>
      )}

      {/* Business profile ---------------------------------------------------- */}
      {section !== 'terms' && (
      <>
      <section className="mt-10">
        <h2 className="label-caps">{t('settings.business')}</h2>
        <p className="mt-2 text-2xs text-ink-400">{t('settings.businessHint')}</p>

        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <Field
            label={t('settings.nameEn')}
            value={values.nameEn}
            onChange={(event) => set('nameEn', event.target.value)}
          />
          <Field
            label={t('settings.nameAr')}
            value={values.nameAr}
            dir="rtl"
            onChange={(event) => set('nameAr', event.target.value)}
          />
          <Field
            label={t('settings.addressEn')}
            value={values.addressEn}
            onChange={(event) => set('addressEn', event.target.value)}
          />
          <Field
            label={t('settings.addressAr')}
            value={values.addressAr}
            dir="rtl"
            onChange={(event) => set('addressAr', event.target.value)}
          />
          <Field
            label={t('settings.phone')}
            value={values.phone}
            onChange={(event) => set('phone', event.target.value)}
          />
          <Field
            label={t('settings.whatsapp')}
            value={values.whatsapp}
            onChange={(event) => set('whatsapp', event.target.value)}
          />
          <Field
            label={t('settings.email')}
            value={values.email}
            onChange={(event) => set('email', event.target.value)}
          />
          <Field
            label={t('settings.website')}
            value={values.website}
            onChange={(event) => set('website', event.target.value)}
          />
          <Field
            label={t('settings.vatNumber')}
            value={values.vatNumber}
            hint={t('settings.registrationHint')}
            onChange={(event) => set('vatNumber', event.target.value)}
          />
          <Field
            label={t('settings.crNumber')}
            value={values.crNumber}
            onChange={(event) => set('crNumber', event.target.value)}
          />
        </div>

        <Button className="mt-6" disabled={busy} onClick={() => void save()}>
          {busy ? t('action.saving') : t('action.save')}
        </Button>
      </section>

      {/* Logo ---------------------------------------------------------------- */}
      <section className="mt-10 border-t border-ink-100 pt-6">
        <h2 className="label-caps">{t('settings.logo')}</h2>
        <p className="mt-2 text-2xs text-ink-400">{t('settings.logoHint')}</p>

        <div className="mt-4 flex flex-wrap items-center gap-6">
          {logoUrl === null ? (
            <p className="text-sm text-ink-400">{t('settings.noLogo')}</p>
          ) : (
            <img src={logoUrl} alt="" className="h-16 w-auto max-w-48 object-contain" />
          )}

          <label className="cursor-pointer text-sm text-ink-700 underline">
            {profile.logoPath === null ? t('settings.uploadLogo') : t('settings.replaceLogo')}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void chooseLogo(file);
              }}
            />
          </label>
        </div>
      </section>
      </>
      )}

      {/* Terms --------------------------------------------------------------- */}
      {section !== 'business' && (
      <section className="mt-10 border-t border-ink-100 pt-6" data-section="terms">
        <h2 className="label-caps">{t('settings.terms')}</h2>
        <p className="mt-2 text-2xs text-ink-400">{t('settings.termsHint')}</p>
        <p className="mt-1 text-2xs text-ink-400">{t('settings.termsImmutable')}</p>

        {versions.length > 0 && (
          <ul className="mt-6 divide-y divide-ink-100">
            {versions.map((version) => (
              <li key={version.id} className="flex flex-wrap items-center gap-4 py-3">
                <span className="flex-1 text-sm text-ink-900">{version.label || version.id}</span>
                <span className="numeric text-2xs text-ink-400">
                  {version.createdAt > 0 ? formatMuscat(version.createdAt, language) : ''}
                </span>

                {version.id === activeId ? (
                  <span className="text-2xs text-ink-600">{t('settings.activeVersion')}</span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || principal === null}
                    onClick={() => {
                      if (principal !== null) {
                        void setActiveTermsVersion(version.id, principal.uid);
                      }
                    }}
                  >
                    {t('settings.useVersion')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-8 space-y-8">
          {sections.map((section, index) => (
            <div key={section.key}>
              <h3 className="text-sm font-medium text-ink-900">
                {t(`terms.${section.key as TermsSectionKey}`)}
              </h3>

              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field
                  label={t('terms.titleEn')}
                  value={section.titleEn}
                  onChange={(event) =>
                    setSections((current) =>
                      current.map((entry, position) =>
                        position === index ? { ...entry, titleEn: event.target.value } : entry,
                      ),
                    )
                  }
                />
                <Field
                  label={t('terms.titleAr')}
                  value={section.titleAr}
                  dir="rtl"
                  onChange={(event) =>
                    setSections((current) =>
                      current.map((entry, position) =>
                        position === index ? { ...entry, titleAr: event.target.value } : entry,
                      ),
                    )
                  }
                />
                <TextArea
                  label={t('terms.bodyEn')}
                  value={section.bodyEn}
                  rows={4}
                  {...(missing.en.includes(section.key as TermsSectionKey)
                    ? { hint: t('settings.missingEn') }
                    : {})}
                  onChange={(event) =>
                    setSections((current) =>
                      current.map((entry, position) =>
                        position === index ? { ...entry, bodyEn: event.target.value } : entry,
                      ),
                    )
                  }
                />
                <TextArea
                  label={t('terms.bodyAr')}
                  value={section.bodyAr}
                  rows={4}
                  dir="rtl"
                  {...(missing.ar.includes(section.key as TermsSectionKey)
                    ? { hint: t('settings.missingAr') }
                    : {})}
                  onChange={(event) =>
                    setSections((current) =>
                      current.map((entry, position) =>
                        position === index ? { ...entry, bodyAr: event.target.value } : entry,
                      ),
                    )
                  }
                />
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap items-end gap-4">
          <Field
            label={t('settings.termsVersion')}
            value={versionLabel}
            onChange={(event) => setVersionLabel(event.target.value)}
          />
          <Button disabled={busy} onClick={() => void publish()}>
            {t('settings.publishTerms')}
          </Button>
        </div>
      </section>
      )}
    </div>
  );
}
