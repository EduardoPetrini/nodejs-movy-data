/**
 * Turning a PostgreSQL constraint violation into an answer, rather than a 500.
 *
 * The constraints in this schema are doing real work — a composite foreign key
 * is what makes a cross-tenant reference impossible, a `restrict` is what stops
 * run history being orphaned — so their violations are outcomes the handler
 * should expect, not faults. Left unrecognised, each one becomes a 500 carrying
 * the failing SQL in its body.
 *
 * Lives here rather than in `orgs.repo.ts`, where `isUniqueViolation` started:
 * `route-scoping.test.ts` fails any org-scoped route that imports that module,
 * so a route could not reach the helper it needed without breaching the wall.
 */

const UNIQUE_VIOLATION = '23505';

/**
 * Two codes, not one, and the difference is not academic.
 *
 * `23503 foreign_key_violation` is what an INSERT of a bad reference raises.
 * An `ON DELETE RESTRICT` constraint raises `23001 restrict_violation`
 * instead — a distinction no amount of reading the handler would reveal, and
 * one a unit test asserting the assumed code will happily confirm. Matching
 * only 23503 turned "3 saved migrations still use this connection" into a 500
 * carrying the constraint name, which is how this comment came to exist.
 */
const REFERENCE_VIOLATIONS = ['23503', '23001'];

/**
 * Walks the `cause` chain, because Drizzle wraps a driver error in its own
 * `DrizzleQueryError`. Reading `err.code` alone missed every unique violation
 * and turned "that URL is taken" into a 500 with the failing SQL in the body.
 *
 * Depth-limited, so a self-referencing `cause` cannot spin.
 */
function hasPgCode(err: unknown, codes: readonly string[], depth: number): boolean {
  if (depth < 0 || typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && codes.includes(code)) return true;
  return hasPgCode((err as { cause?: unknown }).cause, codes, depth - 1);
}

export function isUniqueViolation(err: unknown, depth = 4): boolean {
  return hasPgCode(err, [UNIQUE_VIOLATION], depth);
}

/**
 * A row still referenced by another. With `ON DELETE restrict` this is how the
 * database says "something depends on this" — a 409 the user can act on, not a
 * fault.
 */
export function isForeignKeyViolation(err: unknown, depth = 4): boolean {
  return hasPgCode(err, REFERENCE_VIOLATIONS, depth);
}
