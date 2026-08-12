/**
 * Pure guard logic for the trusted server-side operations.
 *
 * These are the decisions the Cloud Functions delegate to: who may bootstrap,
 * who may change a role, who may deactivate an account. Testing them here — with
 * no emulator, no Admin SDK and no network — means every refusal path can be
 * covered exhaustively and fast.
 *
 * The Functions' I/O (transactions, claim writes, audit records) is covered
 * separately by the emulator suite.
 */

import { describe, it, expect } from 'vitest';
import {
  constantTimeEquals,
  effectiveRole,
  evaluateActivationChange,
  evaluateBootstrap,
  evaluateNewUser,
  evaluateRoleChange,
  isRole,
  normaliseEmail,
  normaliseName,
  requireOwner,
  type BootstrapState,
  type CallerContext,
  type StoredProfile,
  type Verdict,
} from '../../functions/src/lib/guards';

const activeOwnerProfile: StoredProfile = { exists: true, role: 'OWNER', active: true };
const activeStaffProfile: StoredProfile = { exists: true, role: 'STAFF', active: true };
const inactiveOwnerProfile: StoredProfile = { exists: true, role: 'OWNER', active: false };
const missingProfile: StoredProfile = { exists: false, role: null, active: null };

const ownerCaller: CallerContext = { uid: 'owner-1', claimRole: 'OWNER' };
const staffCaller: CallerContext = { uid: 'staff-1', claimRole: 'STAFF' };
const anonymousCaller: CallerContext = { uid: null, claimRole: null };

function expectRefusal(verdict: Verdict, code: string): void {
  expect(verdict.ok).toBe(false);
  if (verdict.ok) return;
  expect(verdict.code).toBe(code);
}

describe('isRole()', () => {
  it('accepts only the two defined roles', () => {
    expect(isRole('OWNER')).toBe(true);
    expect(isRole('STAFF')).toBe(true);
    expect(isRole('ADMIN')).toBe(false);
    expect(isRole('owner')).toBe(false);
    expect(isRole(null)).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});

describe('effectiveRole()', () => {
  it('grants OWNER when claim and profile agree', () => {
    expect(effectiveRole(ownerCaller, activeOwnerProfile)).toBe('OWNER');
  });

  it('grants STAFF when both say STAFF', () => {
    expect(effectiveRole(staffCaller, activeStaffProfile)).toBe('STAFF');
  });

  it('applies a demotion immediately despite a stale OWNER claim', () => {
    expect(effectiveRole(ownerCaller, activeStaffProfile)).toBe('STAFF');
  });

  it('defers a promotion until the claim catches up', () => {
    expect(effectiveRole(staffCaller, activeOwnerProfile)).toBe('STAFF');
  });

  it('denies an unauthenticated caller', () => {
    expect(effectiveRole(anonymousCaller, activeOwnerProfile)).toBeNull();
  });

  it('denies a deactivated user holding a valid OWNER claim', () => {
    expect(effectiveRole(ownerCaller, inactiveOwnerProfile)).toBeNull();
  });

  it('denies when no profile document exists', () => {
    expect(effectiveRole(ownerCaller, missingProfile)).toBeNull();
  });

  it('denies a forged or unknown claim value', () => {
    for (const claimRole of ['ADMIN', 'SUPERUSER', '', null, 42, {}]) {
      expect(effectiveRole({ uid: 'u', claimRole }, activeOwnerProfile)).toBeNull();
    }
  });

  it('treats a non-boolean active flag as deactivated', () => {
    for (const active of ['true', 1, null, undefined]) {
      expect(effectiveRole(ownerCaller, { exists: true, role: 'OWNER', active })).toBeNull();
    }
  });
});

describe('requireOwner()', () => {
  it('admits an active owner', () => {
    expect(requireOwner(ownerCaller, activeOwnerProfile).ok).toBe(true);
  });

  it('refuses an unauthenticated caller as unauthenticated, not permission-denied', () => {
    expectRefusal(requireOwner(anonymousCaller, missingProfile), 'unauthenticated');
  });

  it('refuses staff', () => {
    expectRefusal(requireOwner(staffCaller, activeStaffProfile), 'permission-denied');
  });

  it('refuses a deactivated owner', () => {
    expectRefusal(requireOwner(ownerCaller, inactiveOwnerProfile), 'permission-denied');
  });

  it('refuses an owner whose profile is missing', () => {
    expectRefusal(requireOwner(ownerCaller, missingProfile), 'permission-denied');
  });

  it('refuses an owner claim paired with a staff profile', () => {
    // The stale-claim demotion case, at the Function boundary.
    expectRefusal(requireOwner(ownerCaller, activeStaffProfile), 'permission-denied');
  });
});

describe('constantTimeEquals()', () => {
  it('matches identical strings', () => {
    expect(constantTimeEquals('correct-token', 'correct-token')).toBe(true);
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it('rejects different strings of the same length', () => {
    expect(constantTimeEquals('correct-token', 'correcttoken!')).toBe(false);
  });

  it('rejects strings of differing length', () => {
    expect(constantTimeEquals('short', 'a-much-longer-token')).toBe(false);
    expect(constantTimeEquals('a-much-longer-token', 'short')).toBe(false);
    expect(constantTimeEquals('', 'x')).toBe(false);
  });

  it('rejects a prefix of the expected token', () => {
    // The attack this defends against: discovering the secret one character at
    // a time by measuring how long the comparison takes to fail.
    expect(constantTimeEquals('corr', 'correct-token')).toBe(false);
  });
});

const NOT_STARTED: BootstrapState = { completed: false, ownerUid: null };
const COMPLETED: BootstrapState = { completed: true, ownerUid: 'owner-1' };
const TOKEN = 'a-configured-setup-token';

describe('evaluateBootstrap()', () => {
  it('ALLOWS the first owner with a correct token', () => {
    const verdict = evaluateBootstrap(
      { callerUid: 'owner-1', providedToken: TOKEN, expectedToken: TOKEN },
      NOT_STARTED,
    );
    expect(verdict.ok).toBe(true);
  });

  it('DENIES a second owner once bootstrap is complete', () => {
    const verdict = evaluateBootstrap(
      { callerUid: 'someone-else', providedToken: TOKEN, expectedToken: TOKEN },
      COMPLETED,
    );
    expectRefusal(verdict, 'already-exists');
  });

  it('DENIES an unauthenticated caller', () => {
    const verdict = evaluateBootstrap(
      { callerUid: null, providedToken: TOKEN, expectedToken: TOKEN },
      NOT_STARTED,
    );
    expectRefusal(verdict, 'unauthenticated');
  });

  it('DENIES a caller with the wrong token', () => {
    const verdict = evaluateBootstrap(
      { callerUid: 'attacker', providedToken: 'guessed-token', expectedToken: TOKEN },
      NOT_STARTED,
    );
    expectRefusal(verdict, 'permission-denied');
  });

  it('DENIES a caller supplying no token', () => {
    for (const providedToken of [undefined, null, '', 42, {}]) {
      const verdict = evaluateBootstrap(
        { callerUid: 'someone', providedToken, expectedToken: TOKEN },
        NOT_STARTED,
      );
      expectRefusal(verdict, 'invalid-argument');
    }
  });

  it('DENIES everyone when no token is configured on the deployment', () => {
    // Refusing is the safe default: with no configured secret there is no way to
    // tell the intended owner from whoever reached the URL first.
    for (const expectedToken of [undefined, '']) {
      const verdict = evaluateBootstrap(
        { callerUid: 'someone', providedToken: 'anything', expectedToken },
        NOT_STARTED,
      );
      expectRefusal(verdict, 'failed-precondition');
    }
  });

  it('ALLOWS the recorded owner to replay, so a failed claim write can be repaired', () => {
    const verdict = evaluateBootstrap(
      { callerUid: 'owner-1', providedToken: TOKEN, expectedToken: TOKEN },
      COMPLETED,
    );
    expect(verdict.ok).toBe(true);
  });

  it('DENIES a replay by a different user even with the right token', () => {
    const verdict = evaluateBootstrap(
      { callerUid: 'not-the-owner', providedToken: TOKEN, expectedToken: TOKEN },
      COMPLETED,
    );
    expectRefusal(verdict, 'already-exists');
  });

  it('DENIES when bootstrap is complete but no owner uid was recorded', () => {
    const verdict = evaluateBootstrap(
      { callerUid: 'anyone', providedToken: TOKEN, expectedToken: TOKEN },
      { completed: true, ownerUid: null },
    );
    expectRefusal(verdict, 'already-exists');
  });

  it('checks the token before revealing whether bootstrap is already complete', () => {
    // A wrong token yields permission-denied whether or not an owner exists, so
    // the endpoint does not become an oracle for "has this boutique been set up".
    const beforeSetup = evaluateBootstrap(
      { callerUid: 'attacker', providedToken: 'wrong', expectedToken: TOKEN },
      NOT_STARTED,
    );
    const afterSetup = evaluateBootstrap(
      { callerUid: 'attacker', providedToken: 'wrong', expectedToken: TOKEN },
      COMPLETED,
    );
    expectRefusal(beforeSetup, 'permission-denied');
    expectRefusal(afterSetup, 'permission-denied');
  });
});

describe('evaluateRoleChange()', () => {
  it('ALLOWS an owner promoting a staff member', () => {
    expect(
      evaluateRoleChange({ actorUid: 'owner-1', targetUid: 'staff-1', newRole: 'OWNER' }, true).ok,
    ).toBe(true);
  });

  it('ALLOWS an owner demoting another owner', () => {
    expect(
      evaluateRoleChange({ actorUid: 'owner-1', targetUid: 'owner-2', newRole: 'STAFF' }, true).ok,
    ).toBe(true);
  });

  it('DENIES an owner changing their own role', () => {
    // Self-demotion can leave the boutique with no owner and no way back.
    expectRefusal(
      evaluateRoleChange({ actorUid: 'owner-1', targetUid: 'owner-1', newRole: 'STAFF' }, true),
      'failed-precondition',
    );
  });

  it('DENIES an unknown target', () => {
    expectRefusal(
      evaluateRoleChange({ actorUid: 'owner-1', targetUid: 'ghost', newRole: 'STAFF' }, false),
      'not-found',
    );
  });

  it('DENIES an invalid role, including privilege-sounding ones', () => {
    for (const newRole of ['ADMIN', 'SUPERUSER', 'owner', '', null, undefined, 42]) {
      expectRefusal(
        evaluateRoleChange({ actorUid: 'owner-1', targetUid: 'staff-1', newRole }, true),
        'invalid-argument',
      );
    }
  });

  it('DENIES a missing or malformed target uid', () => {
    for (const targetUid of ['', null, undefined, 42, {}]) {
      expectRefusal(
        evaluateRoleChange({ actorUid: 'owner-1', targetUid, newRole: 'STAFF' }, true),
        'invalid-argument',
      );
    }
  });
});

describe('evaluateActivationChange()', () => {
  it('ALLOWS an owner deactivating a staff member', () => {
    expect(
      evaluateActivationChange({ actorUid: 'owner-1', targetUid: 'staff-1', active: false }, true)
        .ok,
    ).toBe(true);
  });

  it('ALLOWS an owner reactivating a staff member', () => {
    expect(
      evaluateActivationChange({ actorUid: 'owner-1', targetUid: 'staff-1', active: true }, true)
        .ok,
    ).toBe(true);
  });

  it('DENIES an owner deactivating themselves', () => {
    expectRefusal(
      evaluateActivationChange({ actorUid: 'owner-1', targetUid: 'owner-1', active: false }, true),
      'failed-precondition',
    );
  });

  it('DENIES an unknown target', () => {
    expectRefusal(
      evaluateActivationChange({ actorUid: 'owner-1', targetUid: 'ghost', active: false }, false),
      'not-found',
    );
  });

  it('DENIES a non-boolean active value', () => {
    for (const active of ['false', 0, 1, null, undefined, {}]) {
      expectRefusal(
        evaluateActivationChange({ actorUid: 'owner-1', targetUid: 'staff-1', active }, true),
        'invalid-argument',
      );
    }
  });

  it('DENIES a missing target uid', () => {
    expectRefusal(
      evaluateActivationChange({ actorUid: 'owner-1', targetUid: '', active: false }, true),
      'invalid-argument',
    );
  });
});

describe('evaluateNewUser()', () => {
  it('ALLOWS a well-formed staff account', () => {
    expect(
      evaluateNewUser({ name: 'Fatima Al Balushi', email: 'fatima@example.com', role: 'STAFF' }).ok,
    ).toBe(true);
  });

  it('DENIES a missing or blank name', () => {
    for (const name of ['', '   ', null, undefined, 42]) {
      expectRefusal(evaluateNewUser({ name, email: 'a@b.com', role: 'STAFF' }), 'invalid-argument');
    }
  });

  it('DENIES an absurdly long name', () => {
    expectRefusal(
      evaluateNewUser({ name: 'x'.repeat(121), email: 'a@b.com', role: 'STAFF' }),
      'invalid-argument',
    );
  });

  it('DENIES a malformed email', () => {
    for (const email of ['', 'not-an-email', 'a@b', 'a b@c.com', '@b.com', 'a@.com', null, 42]) {
      expectRefusal(evaluateNewUser({ name: 'Aisha', email, role: 'STAFF' }), 'invalid-argument');
    }
  });

  it('DENIES an invalid role', () => {
    expectRefusal(
      evaluateNewUser({ name: 'Aisha', email: 'a@b.com', role: 'ADMIN' }),
      'invalid-argument',
    );
  });
});

describe('normalisation', () => {
  it('collapses whitespace in names', () => {
    expect(normaliseName('  Fatima   Al   Balushi  ')).toBe('Fatima Al Balushi');
  });

  it('lowercases and trims emails', () => {
    expect(normaliseEmail('  Fatima@Example.COM ')).toBe('fatima@example.com');
  });
});
