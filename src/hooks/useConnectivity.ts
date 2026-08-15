import { useContext } from 'react';

import {
  isOperationAllowed,
  refusalFor,
  type ConnectivityState,
  type GuardedOperation,
} from '@/domain/connectivity';
import {
  ConnectivityContext,
  type ConnectivityContextValue,
} from '@/lib/connectivity/connectivity-context';

export interface ConnectivityHook extends ConnectivityContextValue {
  /** Whether this operation may be attempted right now. */
  readonly allows: (operation: GuardedOperation) => boolean;
  /** Why it may not be, or null when it may. */
  readonly refusal: (operation: GuardedOperation) => string | null;
}

/**
 * Connectivity, and what it permits.
 *
 * The `refusal` shape means a call site never has to remember which message
 * goes with which operation, and never invents its own — every screen that
 * blocks an action explains it in the same words.
 */
export function useConnectivity(): ConnectivityHook {
  const context = useContext(ConnectivityContext);

  if (context === null) {
    throw new Error('useConnectivity must be used inside <ConnectivityProvider>.');
  }

  const state: ConnectivityState = context.state;

  return {
    ...context,
    allows: (operation) => isOperationAllowed(operation, state),
    refusal: (operation) =>
      isOperationAllowed(operation, state) ? null : refusalFor(operation),
  };
}
