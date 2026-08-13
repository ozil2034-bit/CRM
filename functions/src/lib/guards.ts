/**
 * Pure authorization guards for the trusted server-side operations.
 *
 * No Firebase imports, no I/O, no clock. Every privileged decision a Cloud
 * Function makes is expressed here as a function from plain data to a verdict,
 * so the decisions can be tested exhaustively without an emulator, an Admin SDK
 * or a network.
 *
 * The Functions in this package do the I/O; these functions decide.
 */

export type Role = 'OWNER' | 'STAFF';

export function isRole(value: unknown): value is Role {
  return value === 'OWNER' || value === 'STAFF';
}

/** A verdict. `ok` means proceed; otherwise `code` names the refusal. */
export type Verdict =
  { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string };

const allow = (): Verdict => ({ ok: true });
const refuse = (code: string, message: string): Verdict => ({ ok: false, code, message });

/* ------------------------------------------------------------------------ *
 * Caller identity
 * ------------------------------------------------------------------------ */

export interface CallerContext {
  /** uid from the verified ID token, or null when unauthenticated. */
  readonly uid: string | null;
  /** `role` custom claim as presented in the verified token. */
  readonly claimRole: unknown;
}

export interface StoredProfile {
  readonly exists: boolean;
  readonly role: unknown;
  readonly active: unknown;
}

/**
 * Resolve the caller's effective role from the token claim and their stored
 * profile, taking the lower of the two.
 *
 * Identical in intent to `resolveEffectiveRole` in src/domain/authorization.ts
 * and to `isOwner()` in firestore.rules. The three are deliberate mirrors:
 * the browser decides what to render, the rules guard direct SDK access, and
 * this guards the privileged Functions. Each is independently enforced, so a
 * mistake in one is not a mistake in all three.
 */
export function effectiveRole(caller: CallerContext, profile: StoredProfile): Role | null {
  if (caller.uid === null) return null;
  if (!profile.exists) return null;
  if (profile.active !== true) return null;
  if (!isRole(caller.claimRole) || !isRole(profile.role)) return null;

  return caller.claimRole === 'OWNER' && profile.role === 'OWNER' ? 'OWNER' : 'STAFF';
}

/** The caller must be an active owner confirmed by both claim and profile. */
export function requireOwner(caller: CallerContext, profile: StoredProfile): Verdict {
  if (caller.uid === null) {
    return refuse('unauthenticated', 'Sign in to perform this action.');
  }

  const role = effectiveRole(caller, profile);

  if (role === null) {
    return refuse('permission-denied', 'This account is not an active employee.');
  }
  if (role !== 'OWNER') {
    return refuse('permission-denied', 'Only the boutique owner can perform this action.');
  }
  return allow();
}

/* ------------------------------------------------------------------------ *
 * Owner bootstrap
 * ------------------------------------------------------------------------ */

export interface BootstrapState {
  /** Whether the sentinel document records a completed bootstrap. */
  readonly completed: boolean;
  /** uid recorded as the first owner, when completed. */
  readonly ownerUid: string | null;
}

export interface BootstrapRequest {
  readonly callerUid: string | null;
  /** Setup token supplied by the operator, as received. */
  readonly providedToken: unknown;
  /** Setup token configured server-side. */
  readonly expectedToken: string | undefined;
}

/**
 * Decide whether a caller may claim initial ownership.
 *
 * Four independent conditions, in the order that leaks the least:
 *
 * 1. The caller must be authenticated. Ownership is granted to an identity, not
 *    to a request.
 * 2. A setup token must be configured server-side. Without one the boutique has
 *    no way to distinguish its intended owner from whoever reaches the URL
 *    first, so bootstrap is refused rather than opened.
 * 3. The provided token must match, compared in constant time by the caller.
 * 4. Bootstrap must not already be complete.
 *
 * Re-running as the recorded owner is allowed and idempotent. That matters
 * because granting the claim happens after the transaction commits: if that
 * second step fails, the recorded owner would otherwise hold a profile with no
 * claim and be locked out with no way back.
 */
export function evaluateBootstrap(request: BootstrapRequest, state: BootstrapState): Verdict {
  if (request.callerUid === null) {
    return refuse('unauthenticated', 'Create an account before claiming ownership.');
  }

  if (typeof request.expectedToken !== 'string' || request.expectedToken.length === 0) {
    return refuse(
      'failed-precondition',
      'Owner bootstrap is not configured on this deployment. Set the setup token before first run.',
    );
  }

  if (typeof request.providedToken !== 'string' || request.providedToken.length === 0) {
    return refuse('invalid-argument', 'A setup token is required.');
  }

  if (!constantTimeEquals(request.providedToken, request.expectedToken)) {
    return refuse('permission-denied', 'The setup token is not valid.');
  }

  if (state.completed) {
    // Idempotent replay by the recorded owner: allow, so a failed claim write
    // can be retried. Anyone else is refused — this is the second-owner case.
    if (state.ownerUid !== null && state.ownerUid === request.callerUid) {
      return allow();
    }
    return refuse(
      'already-exists',
      'This boutique already has an owner. Ownership can only be claimed once.',
    );
  }

  return allow();
}

/**
 * Compare two secrets without leaking their relationship through timing.
 *
 * A naive `===` on strings short-circuits at the first differing byte, which
 * over many attempts reveals the expected value one character at a time. The
 * length is folded into the result rather than returned early for the same
 * reason.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const lengthMismatch = a.length !== b.length;
  const limit = Math.max(a.length, b.length);

  let difference = lengthMismatch ? 1 : 0;

  for (let index = 0; index < limit; index += 1) {
    // charCodeAt past the end yields NaN; `| 0` normalises it to 0 so the loop
    // stays branch-free and runs the full length regardless of input.
    const left = a.charCodeAt(index) | 0;
    const right = b.charCodeAt(index) | 0;
    difference |= left ^ right;
  }

  return difference === 0;
}

/* ------------------------------------------------------------------------ *
 * Role and activation changes
 * ------------------------------------------------------------------------ */

export interface RoleChangeRequest {
  readonly actorUid: string;
  readonly targetUid: unknown;
  readonly newRole: unknown;
}

/**
 * Validate an owner's request to change another user's role.
 *
 * Self-demotion is refused. Role assignment requires an existing owner, so an
 * owner who demotes themselves can leave the boutique with nobody able to reach
 * settings, terms or user management, and no in-application route back —
 * recovery would need a developer holding Admin SDK credentials.
 */
export function evaluateRoleChange(request: RoleChangeRequest, targetExists: boolean): Verdict {
  if (typeof request.targetUid !== 'string' || request.targetUid.length === 0) {
    return refuse('invalid-argument', 'A target user is required.');
  }

  if (!isRole(request.newRole)) {
    return refuse('invalid-argument', 'Role must be either OWNER or STAFF.');
  }

  if (request.targetUid === request.actorUid) {
    return refuse(
      'failed-precondition',
      'You cannot change your own role. Ask another owner to do it.',
    );
  }

  if (!targetExists) {
    return refuse('not-found', 'That user does not exist.');
  }

  return allow();
}

export interface ActivationChangeRequest {
  readonly actorUid: string;
  readonly targetUid: unknown;
  readonly active: unknown;
}

/**
 * Validate an owner's request to activate or deactivate a user.
 *
 * Self-deactivation is refused for the same lockout reason as self-demotion.
 */
export function evaluateActivationChange(
  request: ActivationChangeRequest,
  targetExists: boolean,
): Verdict {
  if (typeof request.targetUid !== 'string' || request.targetUid.length === 0) {
    return refuse('invalid-argument', 'A target user is required.');
  }

  if (typeof request.active !== 'boolean') {
    return refuse('invalid-argument', 'Active must be true or false.');
  }

  if (request.targetUid === request.actorUid) {
    return refuse(
      'failed-precondition',
      'You cannot deactivate your own account. Ask another owner to do it.',
    );
  }

  if (!targetExists) {
    return refuse('not-found', 'That user does not exist.');
  }

  return allow();
}

/* ------------------------------------------------------------------------ *
 * Input validation
 * ------------------------------------------------------------------------ */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface NewUserRequest {
  readonly name: unknown;
  readonly email: unknown;
  readonly role: unknown;
}

export function evaluateNewUser(request: NewUserRequest): Verdict {
  if (typeof request.name !== 'string' || request.name.trim().length === 0) {
    return refuse('invalid-argument', 'A name is required.');
  }
  if (request.name.trim().length > 120) {
    return refuse('invalid-argument', 'That name is too long.');
  }
  if (typeof request.email !== 'string' || !EMAIL_PATTERN.test(request.email.trim())) {
    return refuse('invalid-argument', 'A valid email address is required.');
  }
  if (!isRole(request.role)) {
    return refuse('invalid-argument', 'Role must be either OWNER or STAFF.');
  }
  return allow();
}

/** Normalise a display name for storage. */
export function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Normalise an email address for storage and comparison. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
