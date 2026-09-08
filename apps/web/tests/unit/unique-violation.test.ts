import { describe, it, expect } from 'vitest';
import { isUniqueViolation } from '../../server/repositories/orgs.repo';

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
