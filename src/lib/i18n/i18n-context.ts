import { createContext } from 'react';

import type { TranslationKey, UiLanguage } from './dictionary';

export interface I18nContextValue {
  readonly language: UiLanguage;
  readonly direction: 'ltr' | 'rtl';
  readonly isRtl: boolean;
  /** Translate. A key that does not exist is a compile error, not a fallback. */
  readonly t: (key: TranslationKey) => string;
  readonly setLanguage: (language: UiLanguage) => void;
  readonly toggleLanguage: () => void;
}

export const I18nContext = createContext<I18nContextValue | null>(null);
