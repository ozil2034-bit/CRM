import { useContext } from 'react';
import { AuthContext, type AuthContextValue } from '@/app/auth-context';

/**
 * Access the current identity.
 *
 * Throws when used outside the provider — that is a wiring mistake, not a
 * runtime condition worth branching on at every call site.
 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (context === null) {
    throw new Error('useAuth must be used inside <AuthProvider>.');
  }

  return context;
}
