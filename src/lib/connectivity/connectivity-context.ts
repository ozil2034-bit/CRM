import { createContext } from 'react';

import type { ConnectivityState } from '@/domain/connectivity';

export interface ConnectivityContextValue {
  readonly state: ConnectivityState;
  readonly isOnline: boolean;
  /** True for both `offline` and `reconnecting`. Guarded operations use this. */
  readonly isOffline: boolean;
}

export const ConnectivityContext = createContext<ConnectivityContextValue | null>(null);
