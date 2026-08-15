import type { UiLanguage } from './dictionary';

const STORAGE_KEY = 'azhary.language';

/**
 * Read the preferred interface language.
 *
 * This is a UI preference, not business data, so keeping it on the device is
 * appropriate — the lint rule that forbids `localStorage` exists to stop it
 * being used as a *database*, which this is not. Wrapped in try/catch because
 * storage throws in private browsing modes.
 *
 * It lives in its own module, outside the provider, because the root error
 * boundary needs it at a moment when there is no provider left to ask.
 */
export function readStoredLanguage(): UiLanguage {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return stored === 'ar' || stored === 'en' ? stored : 'en';
  } catch {
    return 'en';
  }
}

export function storeLanguage(language: UiLanguage): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, language);
  } catch {
    // A device that refuses storage still gets a working application; the
    // choice simply does not survive a reload.
  }
}
