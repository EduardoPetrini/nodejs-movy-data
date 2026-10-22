import { describe, it, expect } from 'vitest';
import {
  classifyConnectionError,
  summaryForKind,
  type ConnectionFailureKind,
} from '../../../src/domain/errors/connection-failure';

/**
 * The taxonomy exists so that "fix the credential", "the database is down" and
 * "ask an admin for a grant" stop arriving as the same red box. Its one hard
 * rule is that a WRONG classification is worse than none — telling someone
 * their password is wrong when the host is unreachable sends them to rotate a
 * working credential — so `unknown` is a legitimate answer and is tested as one.
 */

function withCode(code: string, message = 'driver said something'): Error {
  return Object.assign(new Error(message), { code });
}

describe('classifyConnectionError — by driver code', () => {
  const cases: readonly [string, ConnectionFailureKind][] = [
    ['28P01', 'auth'],            // PostgreSQL: password authentication failed
    ['3D000', 'missing_database'],// PostgreSQL: database does not exist
    ['42501', 'permission'],      // PostgreSQL: insufficient privilege
    ['ER_ACCESS_DENIED_ERROR', 'auth'],
    ['ER_BAD_DB_ERROR', 'missing_database'],
    ['ER_DBACCESS_DENIED_ERROR', 'permission'],
    ['ELOGIN', 'auth'],           // tedious / MSSQL
    ['ECONNREFUSED', 'unreachable'],
    ['ENOTFOUND', 'unreachable'],
    ['ETIMEDOUT', 'timeout'],
    ['CERT_HAS_EXPIRED', 'tls'],
  ];

  it.each(cases)('maps %s to %s', (code, expected) => {
    expect(classifyConnectionError(withCode(code)).kind).toBe(expected);
  });

  it('reads the code tedious buries on originalError', () => {
    const wrapped = Object.assign(new Error('Connection lost'), {
      originalError: withCode('ELOGIN'),
    });
    expect(classifyConnectionError(wrapped).kind).toBe('auth');
  });

  it('prefers the code over the prose when both are present', () => {
    // A connection refused while the message happens to mention a password.
    const err = withCode('ECONNREFUSED', 'could not send password packet');
    expect(classifyConnectionError(err).kind).toBe('unreachable');
  });
});

describe('classifyConnectionError — by prose', () => {
  it.each([
    ['password authentication failed for user "movy"', 'auth'],
    ['Access denied for user \'movy\'@\'10.0.0.2\'', 'auth'],
    ['Login failed for user \'movy\'.', 'auth'],
    ['permission denied for table orders', 'permission'],
    ['database "movy_dst" does not exist', 'missing_database'],
    ['self-signed certificate in certificate chain', 'tls'],
    ['Request timed out', 'timeout'],
    ['getaddrinfo ENOTFOUND db.internal', 'unreachable'],
  ] as const)('classifies %j as %s', (message, expected) => {
    expect(classifyConnectionError(new Error(message)).kind).toBe(expected);
  });

  it('returns unknown rather than guessing', () => {
    expect(classifyConnectionError(new Error('something odd happened')).kind).toBe('unknown');
    expect(classifyConnectionError('a bare string').kind).toBe('unknown');
    expect(classifyConnectionError(null).kind).toBe('unknown');
  });
});

describe('the summaries', () => {
  const kinds: readonly ConnectionFailureKind[] = [
    'auth', 'unreachable', 'permission', 'missing_database', 'tls', 'timeout', 'unknown',
  ];

  it('gives every kind a sentence', () => {
    for (const kind of kinds) {
      expect(summaryForKind(kind).length).toBeGreaterThan(20);
    }
  });

  it('never names an engine or quotes a driver', () => {
    // The summary sits beside the driver's own (redacted) text, not instead of
    // it, and a summary that said "PostgreSQL" would be wrong on two engines.
    for (const kind of kinds) {
      expect(summaryForKind(kind)).not.toMatch(/postgres|mysql|mssql|sqlstate/i);
    }
  });

  it('is the same sentence whichever way the kind was reached', () => {
    const byCode = classifyConnectionError(withCode('28P01'));
    const byProse = classifyConnectionError(new Error('password authentication failed'));
    expect(byCode.summary).toBe(byProse.summary);
  });
});
