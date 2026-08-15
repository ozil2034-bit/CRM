import { Component, type ErrorInfo, type ReactNode } from 'react';

import { developerDetail } from '@/domain/firebase-errors';
import { DICTIONARIES, type UiLanguage } from '@/lib/i18n/dictionary';
import { readStoredLanguage } from '@/lib/i18n/language';

/**
 * The last boundary — §45.
 *
 * `AppErrorBoundary` catches anything that fails *inside* a route. This catches
 * what it cannot: a provider that throws while mounting, a failure in the auth
 * subscription, a router that could not be constructed. At that point there is
 * no router to navigate with and no context to read, so this deliberately
 * depends on **nothing**: no hooks, no design system, no i18n context.
 *
 * It still speaks the employee's language. The language preference is read
 * straight from storage and the dictionary is imported as a plain object, so the
 * one screen an Arabic employee is most likely to be frightened by is not the
 * one screen that reverts to English.
 *
 * Only a reload is offered. Anything finer would be a claim about state this
 * boundary cannot verify.
 */
interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly crashed: boolean;
}

export class RootErrorBoundary extends Component<Props, State> {
  override state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    /*
     * Development only, and for the same reason as everywhere else: a component
     * stack names the screen, and the error can name the customer on it. A
     * boutique tablet's console is not a private place.
     */
    if (import.meta.env.DEV) {
      console.error(developerDetail(error), info.componentStack);
    }
  }

  override render(): ReactNode {
    if (!this.state.crashed) {
      return this.props.children;
    }

    const language: UiLanguage = readStoredLanguage();
    const t = (key: 'crash.eyebrow' | 'crash.title' | 'crash.reassurance' | 'crash.reload') =>
      DICTIONARIES[language][key];

    return (
      <main
        dir={language === 'ar' ? 'rtl' : 'ltr'}
        lang={language}
        className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16"
      >
        <p className="label-caps">{t('crash.eyebrow')}</p>
        <h1 className="display mt-3 text-3xl text-ink-900">{t('crash.title')}</h1>
        <p className="mt-4 text-2xs text-ink-400">{t('crash.reassurance')}</p>

        <div className="mt-8">
          {/*
           * A plain button, not the design-system one: if the failure was in a
           * shared component this screen must not depend on shared components.
           */}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="min-h-11 rounded-xs bg-ink-900 px-5 text-sm text-white"
          >
            {t('crash.reload')}
          </button>
        </div>
      </main>
    );
  }
}
