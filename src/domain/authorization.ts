/**
 * Authorization — pure role and permission logic.
 *
 * ⚠️ THIS MODULE IS NOT A SECURITY CONTROL.
 *
 * Everything here runs in the browser, where an attacker owns the runtime. Its
 * only job is to decide what the interface offers: which buttons render, which
 * routes mount, which menu entries appear. A user who bypasses it reaches
 * Firestore and is refused by the security rules, which are the actual control.
 *
 * The permission table below is a deliberate mirror of the matrix in
 * SECURITY.md §3 and of firestore.rules. When the three disagree, the rules win
 * and the disagreement is a bug in this file. `authorization.test.ts` asserts
 * the table against the specification, and the rules tests assert the rules
 * against the same matrix, so a drift in either surfaces as a failure.
 *
 * Pure: no I/O, no Firebase, no React, no clock.
 */

export type Role = 'OWNER' | 'STAFF';

export const ROLES: readonly Role[] = ['OWNER', 'STAFF'] as const;

export function isRole(value: unknown): value is Role {
  return value === 'OWNER' || value === 'STAFF';
}

/**
 * The signed-in user as the application understands them.
 *
 * `role` is the *effective* role produced by {@link resolveEffectiveRole} —
 * never a raw claim and never a raw document field.
 */
export interface Principal {
  readonly uid: string;
  readonly role: Role;
  readonly active: boolean;
}

/* ------------------------------------------------------------------------ *
 * Effective role resolution
 * ------------------------------------------------------------------------ */

export interface RoleSources {
  /** `role` from the Firebase Auth custom claim. Only a Cloud Function can set it. */
  readonly claimRole: unknown;
  /** `role` from `users/{uid}`. Clients cannot write this field; rules forbid it. */
  readonly documentRole: unknown;
  /** `active` from `users/{uid}`. The live deactivation switch. */
  readonly documentActive: unknown;
  /** Whether `users/{uid}` exists at all. */
  readonly documentExists: boolean;
}

/**
 * Resolve the role a request actually carries, from two independent sources.
 *
 * Both the custom claim and the user document must agree that the caller is an
 * employee, and the **lower** of the two roles wins.
 *
 * Why two sources rather than one:
 *
 * - The claim alone cannot express deactivation promptly. Claims are minted into
 *   the ID token and remain valid until it expires — up to an hour. An employee
 *   dismissed at 09:00 would keep full access until 10:00. Reading `active` from
 *   Firestore makes revocation take effect on the employee's very next request.
 *
 * - The document alone would make the role a database field, and a database
 *   field is something a future rule bug could expose to a client write. The
 *   claim is unreachable from any client under any rule.
 *
 * Taking the lower of the two roles makes the stale-token window fail safe in
 * both directions:
 *
 * - Promotion STAFF → OWNER: the document says OWNER, the stale claim says
 *   STAFF. The user stays STAFF until their token refreshes. They are briefly
 *   under-privileged, which is the harmless direction.
 * - Demotion OWNER → STAFF: the document says STAFF, the stale claim still says
 *   OWNER. The user drops to STAFF immediately, because the demoted document
 *   role caps them. The privilege removal is not deferred.
 *
 * Returning `null` means "not an employee", which every caller must treat as no
 * access at all.
 */
export function resolveEffectiveRole(sources: RoleSources): Role | null {
  const { claimRole, documentRole, documentActive, documentExists } = sources;

  // No profile document means no access, even holding a valid claim. This is
  // what stops a half-completed or rolled-back user creation from granting
  // access on the strength of a claim that was written first.
  if (!documentExists) {
    return null;
  }

  // Deactivation is absolute and is checked before anything else.
  if (documentActive !== true) {
    return null;
  }

  if (!isRole(claimRole) || !isRole(documentRole)) {
    return null;
  }

  // OWNER only when both sources say OWNER; otherwise the lower role, STAFF.
  return claimRole === 'OWNER' && documentRole === 'OWNER' ? 'OWNER' : 'STAFF';
}

/* ------------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------------ */

export type Permission =
  // Customers
  | 'customers.view'
  | 'customers.create'
  | 'customers.edit'
  | 'customers.delete'
  // Dresses
  | 'dresses.view'
  | 'dresses.create'
  | 'dresses.edit'
  | 'dresses.delete'
  | 'dresses.viewPurchaseCost'
  // Reservations
  | 'reservations.view'
  | 'reservations.create'
  | 'reservations.edit'
  | 'reservations.cancel'
  | 'reservations.delete'
  // Fittings
  | 'fittings.view'
  | 'fittings.manage'
  // Operations
  | 'pickup.process'
  | 'return.process'
  | 'damage.record'
  | 'whatsapp.prepare'
  // Money
  | 'payments.view'
  | 'payments.record'
  | 'payments.void'
  | 'payments.delete'
  | 'invoices.view'
  | 'invoices.issue'
  | 'invoices.void'
  | 'invoices.delete'
  | 'deposits.settle'
  // Reports
  | 'reports.operational'
  | 'reports.financial'
  // Configuration — owner only
  | 'settings.view'
  | 'settings.editVat'
  | 'settings.editPricing'
  | 'settings.editCancellation'
  | 'settings.editLateFee'
  | 'settings.editNumbering'
  | 'businessProfile.edit'
  | 'terms.edit'
  // Administration — owner only
  | 'users.view'
  | 'users.create'
  | 'users.changeRole'
  | 'users.deactivate'
  | 'audit.view'
  | 'data.export'
  | 'data.import';

/**
 * Permissions granted to STAFF.
 *
 * Read as the specification's "Staff can" list. Everything absent is owner-only,
 * and the absences are the point: no settings, no terms, no user management, no
 * deletion of anything financial.
 */
const STAFF_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'customers.view',
  'customers.create',
  'customers.edit',

  'dresses.view',
  'dresses.create',
  'dresses.edit',

  'reservations.view',
  'reservations.create',
  'reservations.edit',
  'reservations.cancel',

  'fittings.view',
  'fittings.manage',

  'pickup.process',
  'return.process',
  'damage.record',
  'whatsapp.prepare',

  'payments.view',
  'payments.record',
  'invoices.view',
  'invoices.issue',
  'deposits.settle',

  'reports.operational',

  // Staff need to read settings — the VAT rate and pickup threshold drive the
  // screens they work in every day. Reading configuration is not changing it.
  'settings.view',
]);

/**
 * Permissions no role holds, ever.
 *
 * Financial and legal history is not deletable, by anyone, including the owner.
 * Corrections are made by voiding, which preserves the record and is audited.
 * These are listed explicitly so that granting one requires deliberately editing
 * this set, rather than quietly adding a role to a table somewhere.
 */
const FORBIDDEN_TO_EVERYONE: ReadonlySet<Permission> = new Set([
  'payments.delete',
  'invoices.delete',
  'reservations.delete',
]);

/**
 * Does this principal hold this permission?
 *
 * A deactivated principal holds nothing. An owner holds everything except what
 * is forbidden to everyone.
 */
export function can(principal: Principal | null, permission: Permission): boolean {
  if (!principal || !principal.active) {
    return false;
  }

  if (FORBIDDEN_TO_EVERYONE.has(permission)) {
    return false;
  }

  if (principal.role === 'OWNER') {
    return true;
  }

  return STAFF_PERMISSIONS.has(permission);
}

/** True when the principal holds every listed permission. */
export function canAll(principal: Principal | null, permissions: readonly Permission[]): boolean {
  return permissions.every((permission) => can(principal, permission));
}

/** True when the principal holds at least one listed permission. */
export function canAny(principal: Principal | null, permissions: readonly Permission[]): boolean {
  return permissions.some((permission) => can(principal, permission));
}

export function isOwner(principal: Principal | null): boolean {
  return principal?.active === true && principal.role === 'OWNER';
}

export function isStaff(principal: Principal | null): boolean {
  return principal?.active === true && principal.role === 'STAFF';
}

export function isEmployee(principal: Principal | null): boolean {
  return isOwner(principal) || isStaff(principal);
}

/* ------------------------------------------------------------------------ *
 * Self-targeting guards
 * ------------------------------------------------------------------------ */

export type SelfActionRefusal = 'SELF_ROLE_CHANGE' | 'SELF_DEACTIVATION' | null;

/**
 * Refuse owner actions that would lock the boutique out of its own system.
 *
 * An owner demoting or deactivating themselves can leave the business with no
 * one able to reach settings, terms or user management — and because role
 * assignment is Cloud-Function-only and requires an existing owner, there is no
 * in-application path back. Recovery would mean a developer with Admin SDK
 * credentials.
 *
 * This is enforced in the Cloud Function as well; the copy here exists so the
 * interface can disable the control and explain why before the user tries.
 */
export function refuseSelfAction(
  actorUid: string,
  targetUid: string,
  action: 'changeRole' | 'deactivate',
): SelfActionRefusal {
  if (actorUid !== targetUid) {
    return null;
  }
  return action === 'changeRole' ? 'SELF_ROLE_CHANGE' : 'SELF_DEACTIVATION';
}
