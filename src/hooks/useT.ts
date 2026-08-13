import { useContext } from 'react';

import { I18nContext, type I18nContextValue } from '@/lib/i18n/i18n-context';

/** Access translation and text direction. */
export function useT(): I18nContextValue {
  const context = useContext(I18nContext);

  if (context === null) {
    throw new Error('useT must be used inside <I18nProvider>.');
  }

  return context;
}
