import { describe, it, expect } from 'vitest';
import { isForeignKeyViolation, isUniqueViolation } from '../../server/repositories/pg-errors';

/**
 * Drizzle wraps the driver's error in a DrizzleQueryError, so the pg code sits
 * on `cause`, not on the error itself. Reading the top level alone turned
 * "that URL is already taken" into a 500 carrying the failing SQL — which is
 * how this test came to exist.
 */
describe('isUniqueViolation', () => {
  it('recognises the pg code on the error itself', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(true);
  });

  it('recognises it through a wrapper', () => {
    const driver = Object.assign(new Error('duplicate key'), { code: '23505' });
    const wrapped = Object.assign(new Error('Failed query'), { cause: driver });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('leaves any other failure alone, so a real fault still surfaces', () => {
    expect(isUniqueViolation(Object.assign(new Error('x'), { code: '23503' }))).toBe(false);
    expect(isUniqueViolation(new Error('plain'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it('does not loop forever on a self-referencing cause', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;
    expect(isUniqueViolation(err)).toBe(false);
  });
});

/**
 * The `restrict` foreign keys on `migration_definitions` make "delete a
 * connection something still uses" a database-level refusal. Recognising it is
 * the difference between a 409 the user can act on and a 500 quoting SQL.
 */
describe('isForeignKeyViolation', () => {
  it('recognises the pg code through Drizzle\'s wrapper', () => {
    const driver = Object.assign(new Error('update or delete violates foreign key'), { code: '23503' });
    expect(isForeignKeyViolation(Object.assign(new Error('Failed query'), { cause: driver }))).toBe(true);
  });

  it('recognises 23001, which is what ON DELETE RESTRICT actually raises', () => {
    // Found against a live database, not here: PostgreSQL raises
    // restrict_violation (23001) for a RESTRICT constraint and
    // foreign_key_violation (23503) for a bad INSERT. Matching only 23503
    // turned the connection-in-use 409 into a 500 quoting the constraint name,
    // and the unit test asserting the assumed code passed the whole time.
    const driver = Object.assign(
      new Error('violates RESTRICT setting of foreign key constraint'),
      { code: '23001' }
    );
    expect(isForeignKeyViolation(Object.assign(new Error('Failed query'), { cause: driver }))).toBe(true);
  });

  it('does not confuse the two codes in either direction', () => {
    expect(isForeignKeyViolation(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
    expect(isUniqueViolation(Object.assign(new Error('x'), { code: '23503' }))).toBe(false);
  });

  it('does not loop forever on a self-referencing cause', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;
    expect(isForeignKeyViolation(err)).toBe(false);
  });
});
