import { describe, it, expect } from 'vitest';
import {
  ROLES,
  can,
  canAll,
  canAny,
  isEmployee,
  isOwner,
  isRole,
  isStaff,
  refuseSelfAction,
  resolveEffectiveRole,
  type Permission,
  type Principal,
  type Role,
} from './authorization';

const owner: Principal = { uid: 'owner-1', role: 'OWNER', active: true };
const staff: Principal = { uid: 'staff-1', role: 'STAFF', active: true };
const inactiveOwner: Principal = { uid: 'owner-2', role: 'OWNER', active: false };
const inactiveStaff: Principal = { uid: 'staff-2', role: 'STAFF', active: false };

describe('isRole()', () => {
  it('accepts the two defined roles', () => {
    expect(isRole('OWNER')).toBe(true);
    expect(isRole('STAFF')).toBe(true);
    expect(ROLES).toEqual(['OWNER', 'STAFF']);
  });

  it('rejects anything else, including near-misses', () => {
    expect(isRole('owner')).toBe(false);
    expect(isRole('ADMIN')).toBe(false);
    expect(isRole('')).toBe(false);
    expect(isRole(null)).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(isRole(1)).toBe(false);
    expect(isRole({ role: 'OWNER' })).toBe(false);
  });
});

describe('resolveEffectiveRole()', () => {
  it('grants OWNER only when both sources agree', () => {
    expect(
      resolveEffectiveRole({
        claimRole: 'OWNER',
        documentRole: 'OWNER',
        documentActive: true,
        documentExists: true,
      }),
    ).toBe('OWNER');
  });

  it('grants STAFF when both sources say STAFF', () => {
    expect(
      resolveEffectiveRole({
        claimRole: 'STAFF',
        documentRole: 'STAFF',
        documentActive: true,
        documentExists: true,
      }),
    ).toBe('STAFF');
  });

  it('caps a pending promotion at STAFF until the token refreshes', () => {
    // Document promoted to OWNER, claim still STAFF. Under-privileged is the
    // harmless direction to fail in.
    expect(
      resolveEffectiveRole({
        claimRole: 'STAFF',
        documentRole: 'OWNER',
        documentActive: true,
        documentExists: true,
      }),
    ).toBe('STAFF');
  });

  it('applies a demotion immediately despite a stale OWNER claim', () => {
    // This is the security-relevant direction: privilege removal must not wait
    // for an ID token to expire.
    expect(
      resolveEffectiveRole({
        claimRole: 'OWNER',
        documentRole: 'STAFF',
        documentActive: true,
        documentExists: true,
      }),
    ).toBe('STAFF');
  });

  it('denies a deactivated user regardless of role', () => {
    for (const role of ROLES) {
      expect(
        resolveEffectiveRole({
          claimRole: role,
          documentRole: role,
          documentActive: false,
          documentExists: true,
        }),
      ).toBeNull();
    }
  });

  it('treats a missing or non-boolean active flag as deactivated', () => {
    // Fail closed: an absent flag is not an implied "yes".
    for (const active of [undefined, null, 'true', 1, 0, {}]) {
      expect(
        resolveEffectiveRole({
          claimRole: 'OWNER',
          documentRole: 'OWNER',
          documentActive: active,
          documentExists: true,
        }),
      ).toBeNull();
    }
  });

  it('denies when the user document does not exist, even holding a valid claim', () => {
    // Guards the window where a claim was written but user creation rolled back.
    expect(
      resolveEffectiveRole({
        claimRole: 'OWNER',
        documentRole: 'OWNER',
        documentActive: true,
        documentExists: false,
      }),
    ).toBeNull();
  });

  it('denies when the claim is missing, malformed or forged to an unknown value', () => {
    for (const claimRole of [undefined, null, '', 'ADMIN', 'owner', 42, {}]) {
      expect(
        resolveEffectiveRole({
          claimRole,
          documentRole: 'OWNER',
          documentActive: true,
          documentExists: true,
        }),
      ).toBeNull();
    }
  });

  it('denies when the document role is missing or malformed', () => {
    for (const documentRole of [undefined, null, '', 'ADMIN', 'staff', 42, {}]) {
      expect(
        resolveEffectiveRole({
          claimRole: 'OWNER',
          documentRole,
          documentActive: true,
          documentExists: true,
        }),
      ).toBeNull();
    }
  });
});

describe('can() — role predicates', () => {
  it('identifies owners, staff and employees', () => {
    expect(isOwner(owner)).toBe(true);
    expect(isOwner(staff)).toBe(false);
    expect(isStaff(staff)).toBe(true);
    expect(isStaff(owner)).toBe(false);
    expect(isEmployee(owner)).toBe(true);
    expect(isEmployee(staff)).toBe(true);
  });

  it('treats deactivated users as nothing at all', () => {
    expect(isOwner(inactiveOwner)).toBe(false);
    expect(isStaff(inactiveStaff)).toBe(false);
    expect(isEmployee(inactiveOwner)).toBe(false);
    expect(isEmployee(inactiveStaff)).toBe(false);
  });

  it('treats a null principal as nothing at all', () => {
    expect(isOwner(null)).toBe(false);
    expect(isStaff(null)).toBe(false);
    expect(isEmployee(null)).toBe(false);
  });
});

/**
 * The specification's "Staff can" list, asserted item by item.
 * Each entry here corresponds to a bullet in the Phase 2 brief.
 */
const STAFF_ALLOWED: readonly Permission[] = [
  'customers.view',
  'customers.create',
  'customers.edit',
  'dresses.view',
  'dresses.create',
  'dresses.edit',
  'reservations.view',
  'reservations.create',
  'reservations.edit',
  'fittings.view',
  'fittings.manage',
  'payments.record',
  'pickup.process',
  'return.process',
  'damage.record',
  'reports.operational',
  'whatsapp.prepare',
  'accessories.view',
  'accessories.manage',
  'alterations.record',
];

/** The specification's "Staff cannot" list, asserted item by item. */
const STAFF_DENIED: readonly Permission[] = [
  'settings.editVat',
  'businessProfile.edit',
  'settings.editPricing',
  'settings.editCancellation',
  'settings.editLateFee',
  'settings.editNumbering',
  'terms.edit',
  'invoices.delete',
  'payments.delete',
  'reservations.delete',
  'users.view',
  'users.create',
  'users.changeRole',
  'users.deactivate',
  'audit.view',
  'payments.void',
  'invoices.void',
  'dresses.viewPurchaseCost',
  'dresses.delete',
  'customers.delete',
  'reports.financial',
  'data.export',
  'data.import',
  // Retiring a catalogue entry changes what the whole boutique can sell.
  'accessories.retire',
];

describe('can() — STAFF', () => {
  it.each(STAFF_ALLOWED)('allows staff to %s', (permission) => {
    expect(can(staff, permission)).toBe(true);
  });

  it.each(STAFF_DENIED)('denies staff %s', (permission) => {
    expect(can(staff, permission)).toBe(false);
  });

  it('lets staff read settings but not change any of them', () => {
    // Staff need the VAT rate and pickup threshold to do their job. Reading
    // configuration is not changing it.
    expect(can(staff, 'settings.view')).toBe(true);
    expect(can(staff, 'settings.editVat')).toBe(false);
  });
});

describe('can() — OWNER', () => {
  const OWNER_ALLOWED: readonly Permission[] = [
    ...STAFF_ALLOWED,
    'settings.view',
    'settings.editVat',
    'settings.editPricing',
    'settings.editCancellation',
    'settings.editLateFee',
    'settings.editNumbering',
    'businessProfile.edit',
    'terms.edit',
    'users.view',
    'users.create',
    'users.changeRole',
    'users.deactivate',
    'audit.view',
    'data.export',
    'data.import',
    'reports.financial',
    'dresses.viewPurchaseCost',
    'dresses.delete',
    'customers.delete',
    'payments.void',
    'invoices.void',
    'invoices.issue',
    'deposits.settle',
    'reservations.cancel',
  ];

  it.each(OWNER_ALLOWED)('allows the owner to %s', (permission) => {
    expect(can(owner, permission)).toBe(true);
  });
});

describe('can() — forbidden to everyone', () => {
  const NEVER: readonly Permission[] = [
    'payments.delete',
    'invoices.delete',
    'reservations.delete',
  ];

  it.each(NEVER)('denies %s even to the owner', (permission) => {
    // Financial and legal history is never destroyed. Corrections are voids,
    // which preserve the record and are audited.
    expect(can(owner, permission)).toBe(false);
    expect(can(staff, permission)).toBe(false);
  });
});

describe('can() — deactivated and anonymous', () => {
  const EVERY_PERMISSION: readonly Permission[] = [
    ...STAFF_ALLOWED,
    ...STAFF_DENIED,
    'settings.view',
    'invoices.view',
    'payments.view',
    'invoices.issue',
    'deposits.settle',
    'reservations.cancel',
  ];

  it.each(EVERY_PERMISSION)('denies a deactivated owner %s', (permission) => {
    expect(can(inactiveOwner, permission)).toBe(false);
  });

  it.each(EVERY_PERMISSION)('denies a deactivated staff member %s', (permission) => {
    expect(can(inactiveStaff, permission)).toBe(false);
  });

  it.each(EVERY_PERMISSION)('denies an unauthenticated visitor %s', (permission) => {
    expect(can(null, permission)).toBe(false);
  });
});

describe('canAll() and canAny()', () => {
  it('canAll requires every permission', () => {
    expect(canAll(staff, ['customers.view', 'dresses.view'])).toBe(true);
    expect(canAll(staff, ['customers.view', 'settings.editVat'])).toBe(false);
    expect(canAll(staff, [])).toBe(true);
  });

  it('canAny requires at least one', () => {
    expect(canAny(staff, ['settings.editVat', 'customers.view'])).toBe(true);
    expect(canAny(staff, ['settings.editVat', 'terms.edit'])).toBe(false);
    expect(canAny(staff, [])).toBe(false);
  });

  it('returns nothing for a deactivated principal regardless of list', () => {
    expect(canAll(inactiveOwner, ['customers.view'])).toBe(false);
    expect(canAny(inactiveOwner, ['customers.view'])).toBe(false);
  });
});

describe('refuseSelfAction()', () => {
  it('refuses an owner demoting themselves', () => {
    // There is no in-application path back: role assignment needs an existing
    // owner, so self-demotion can leave the boutique locked out of its own
    // settings, terms and user management.
    expect(refuseSelfAction('owner-1', 'owner-1', 'changeRole')).toBe('SELF_ROLE_CHANGE');
  });

  it('refuses an owner deactivating themselves', () => {
    expect(refuseSelfAction('owner-1', 'owner-1', 'deactivate')).toBe('SELF_DEACTIVATION');
  });

  it('permits acting on other users', () => {
    expect(refuseSelfAction('owner-1', 'staff-1', 'changeRole')).toBeNull();
    expect(refuseSelfAction('owner-1', 'staff-1', 'deactivate')).toBeNull();
  });
});

describe('permission table mirrors SECURITY.md', () => {
  it('grants the owner strictly more than staff', () => {
    const everyPermission: readonly Permission[] = [...STAFF_ALLOWED, ...STAFF_DENIED];
    for (const permission of everyPermission) {
      if (can(staff, permission)) {
        expect(can(owner, permission)).toBe(true);
      }
    }
  });

  it('assigns every role a defined answer for every permission', () => {
    const roles: readonly Role[] = ROLES;
    for (const role of roles) {
      const principal: Principal = { uid: 'u', role, active: true };
      for (const permission of [...STAFF_ALLOWED, ...STAFF_DENIED]) {
        expect(typeof can(principal, permission)).toBe('boolean');
      }
    }
  });
});
