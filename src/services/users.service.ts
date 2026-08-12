/**
 * Users service — reading the employee list.
 *
 * Writes deliberately live elsewhere: role and activation changes go through
 * `auth.service.ts`, which calls Cloud Functions, because no client can write a
 * custom claim. This module only reads, and only the owner can read the list —
 * the rules refuse a staff `list` on `users`.
 */

import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';

import { getFirebaseClient } from '@/lib/firebase/client';
import { isRole, type Role } from '@/domain/authorization';

export interface EmployeeRecord {
  readonly uid: string;
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly active: boolean;
}

/**
 * Observe the employee list.
 *
 * Live rather than one-shot so a deactivation performed on one device is
 * reflected on another without a refresh.
 */
export function observeUsers(
  onChange: (users: EmployeeRecord[]) => void,
  onError: (message: string) => void,
): () => void {
  const { db } = getFirebaseClient();

  return onSnapshot(
    query(collection(db, 'users'), orderBy('name')),
    (snapshot) => {
      const users: EmployeeRecord[] = [];

      for (const document of snapshot.docs) {
        const data = document.data();
        const role = data['role'];

        // A document whose role is not a recognised value is skipped rather than
        // rendered with a guessed default: showing an unknown privilege level as
        // "Staff" would misrepresent the account.
        if (!isRole(role)) continue;

        users.push({
          uid: document.id,
          name: (data['name'] as string | undefined) ?? '',
          email: (data['email'] as string | undefined) ?? '',
          role,
          active: data['active'] === true,
        });
      }

      onChange(users);
    },
    () => {
      onError('The staff list could not be loaded. You may not have permission to view it.');
    },
  );
}

export { createEmployee, setUserActive, setUserRole } from './auth.service';
