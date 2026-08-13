import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { DICTIONARIES, DIRECTION, type TranslationKey, type UiLanguage } from './dictionary';
import { I18nContext, type I18nContextValue } from './i18n-context';

const STORAGE_KEY = 'azhary.language';

/**
 * Read the preferred interface language.
 *
 * This is a UI preference, not business data, so keeping it on the device is
 * appropriate — the lint rule that forbids `localStorage` exists to stop it
 * being used as a *database*, which this is not. Wrapped in try/catch because
 * storage throws in private browsing modes.
 */
function readStoredLanguage(): UiLanguage {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return stored === 'ar' || stored === 'en' ? stored : 'en';
  } catch {
    return 'en';
  }
}

function storeLanguage(language: UiLanguage): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, language);
  } catch {
    // A device that refuses storage still gets a working application; the
    // choice simply does not survive a reload.
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<UiLanguage>(readStoredLanguage);

  const direction = DIRECTION[language];

  /*
   * `lang` and `dir` are set on the document element rather than a wrapper.
   * Layout uses CSS logical properties (margin-inline-start, ps-/pe-, text-start),
   * so the whole interface mirrors from this one attribute — no mirrored
   * stylesheet, and no per-component RTL branching.
   */
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('lang', language);
    root.setAttribute('dir', direction);
  }, [language, direction]);

  const setLanguage = useCallback((next: UiLanguage) => {
    setLanguageState(next);
    storeLanguage(next);
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    const dictionary = DICTIONARIES[language];

    return {
      language,
      direction,
      isRtl: direction === 'rtl',
      t: (key: TranslationKey) => dictionary[key],
      setLanguage,
      toggleLanguage: () => setLanguage(language === 'en' ? 'ar' : 'en'),
    };
  }, [language, direction, setLanguage]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
