/**
 * The base class for every failure this application raises deliberately.
 *
 * There are two kinds of error an employee can be shown, and they need opposite
 * treatment:
 *
 *   - **Ours.** `ReservationServiceError('overlap', 'That dress is already
 *     booked for those dates.')` — written for the person at the counter, in
 *     terms of the boutique. Showing it verbatim is the whole point of raising
 *     it.
 *
 *   - **The SDK's.** `FirebaseError: Missing or insufficient permissions` —
 *     written for a developer, naming a control the employee cannot see, and
 *     untranslated. Showing it verbatim is a bug.
 *
 * Nothing in a bare `Error` distinguishes the two, so every service error
 * extends this and `useFriendlyError` checks for it. A thrown value that is not
 * an `AppError` is, by definition, something we did not write a message for —
 * and gets one from the dictionary instead.
 */
export class AppError extends Error {
  /** A stable, machine-readable reason. Never shown to an employee. */
  readonly code: string;

  constructor(name: string, code: string, message: string) {
    super(message);
    this.name = name;
    this.code = code;
  }
}
