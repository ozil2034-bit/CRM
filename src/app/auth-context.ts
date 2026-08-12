import { createContext } from 'react';

import type { AuthState } from '@/services/auth.service';
import type { Permission, Principal } from '@/domain/authorization';

export interface AuthContextValue {
  readonly state: AuthState;
  readonly principal: Principal | null;
  readonly isOwner: boolean;
  /**
   * Permission check for rendering decisions only.
   *
   * Hiding a control this cannot justify is a courtesy to the employee, not a
   * security boundary. The boundary is firestore.rules.
   */
  readonly can: (permission: Permission) => boolean;
  readonly signIn: (email: string, password: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
}

/**
 * Kept in its own module so `AuthProvider.tsx` exports only components, which is
 * what lets Fast Refresh preserve state during development.
 */
export const AuthContext = createContext<AuthContextValue | null>(null);
