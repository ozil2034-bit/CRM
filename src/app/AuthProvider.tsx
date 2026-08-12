import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { observeAuth, signIn, signOut, type AuthState } from '@/services/auth.service';
import { can, isOwner } from '@/domain/authorization';
import type { Permission } from '@/domain/authorization';
import { AuthContext, type AuthContextValue } from './auth-context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  // `observeAuth` subscribes to Firebase and calls back on change; it never
  // updates state synchronously during this effect.
  useEffect(() => observeAuth(setState), []);

  const value = useMemo<AuthContextValue>(() => {
    const principal = state.status === 'signed-in' ? state.session.principal : null;

    return {
      state,
      principal,
      isOwner: isOwner(principal),
      can: (permission: Permission) => can(principal, permission),
      signIn,
      signOut,
    };
  }, [state]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
