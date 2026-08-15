import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app/App';
import { RootErrorBoundary } from '@/app/RootErrorBoundary';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import { ConnectivityProvider } from '@/lib/connectivity/ConnectivityProvider';
import { readEnvironment } from '@/config/env';
import { initializeFirebase } from '@/lib/firebase/client';
import '@/styles/index.css';

/*
 * Startup order matters.
 *
 * The environment is validated before Firebase is touched, so a missing
 * configuration value produces a named, actionable message instead of an opaque
 * SDK failure several frames later.
 */
const environment = readEnvironment();

if (environment.status === 'ok') {
  initializeFirebase(environment.env);
}

const container = document.getElementById('root');

if (!container) {
  throw new Error('Root element #root was not found in index.html.');
}

createRoot(container).render(
  <StrictMode>
    {/*
     * Outside every provider on purpose. A crash inside `AuthProvider` or the
     * router is exactly the crash the route boundary cannot catch, and it is
     * the one that would otherwise leave a blank tab.
     */}
    <RootErrorBoundary>
      <I18nProvider>
        <ConnectivityProvider>
          <App environment={environment} />
        </ConnectivityProvider>
      </I18nProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
