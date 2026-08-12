import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app/App';
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
    <App environment={environment} />
  </StrictMode>,
);
