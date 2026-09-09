import { describe, it, expect } from 'vitest';
import { DatabaseType, type ConnectionConfig } from '@movy/core';
import { safeErrorMessage, describeConnectionFailure } from '../../server/utils/safe-error';

/**
 * Five handlers report a failed connection back to the caller as data rather
 * than as a 500 — Test, list databases, list tables, preview and compare — and
 * `recordTest` also PERSISTS the message to `connections.last_test_error`,
 * which `toPublicConnection` serves to viewers. So an unredacted driver error
 * from any of them is a credential disclosure with a long shelf life, readable
 * by the one role that is not allowed to see a connection's host.
 */

const PASSWORD = 'tr0ub4dor&3-correct-horse';

function config(password = PASSWORD): ConnectionConfig {
  return {
    type: DatabaseType.POSTGRES,
    host: 'db.internal',
    port: 5432,
    user: 'movy',
    password,
    database: 'app',
  };
}

describe('safeErrorMessage', () => {
  it('removes the password from a DSN the driver quoted back', () => {
    const err = new Error(`could not connect to postgres://movy:${PASSWORD}@db.internal:5432/app`);
    const message = safeErrorMessage(err, config());

    expect(message).not.toContain(PASSWORD);
    // The rest survives: host and port are what make the message actionable,
    // and the caller supplied them.
    expect(message).toContain('db.internal');
    expect(message).toContain('5432');
  });

  it('removes both passwords when two connections are in play', () => {
    const source = config('source-Pa55word-long');
    const target = config('target-Pa55word-long');
    const err = new Error(`src=${source.password} dst=${target.password}`);

    const message = safeErrorMessage(err, source, target);

    expect(message).not.toContain(source.password);
    expect(message).not.toContain(target.password);
  });

  it('handles a thrown non-Error without crashing the handler', () => {
    expect(safeErrorMessage('a bare string', config())).toBe('a bare string');
    expect(safeErrorMessage(undefined, config())).toBe('undefined');
  });

  it('tolerates a missing config, which is what a null connection row gives', () => {
    expect(safeErrorMessage(new Error('boom'), null, undefined)).toBe('boom');
  });

  it('handles a trusted-auth connection with an empty password', () => {
    // Empty is legitimate and must not turn every character into a redaction.
    const message = safeErrorMessage(new Error('peer authentication failed'), config(''));
    expect(message).toBe('peer authentication failed');
  });
});

describe('describeConnectionFailure', () => {
  it('says what kind of failure it was and what to do about it', () => {
    const err = Object.assign(new Error('password authentication failed'), { code: '28P01' });
    const described = describeConnectionFailure(err, config());

    expect(described.kind).toBe('auth');
    expect(described.summary).toMatch(/credential/i);
    // The driver's own words are kept — redacted — beside the summary, because
    // the classifier answers `unknown` often enough that dropping them would
    // make some failures undiagnosable.
    expect(described.detail).toContain('password authentication failed');
    expect(described.text).toContain(described.summary);
  });

  it('redacts the detail as well as classifying it', () => {
    const err = Object.assign(
      new Error(`FATAL: password authentication failed (dsn postgres://movy:${PASSWORD}@db/app)`),
      { code: '28P01' }
    );
    const described = describeConnectionFailure(err, config());

    expect(described.kind).toBe('auth');
    expect(described.detail).not.toContain(PASSWORD);
    expect(described.text).not.toContain(PASSWORD);
  });

  it('distinguishes an unreachable host from a rejected password', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const rejected = Object.assign(new Error('nope'), { code: '28P01' });

    // The whole point: these two used to arrive as the same red box, and they
    // send an operator to completely different places.
    expect(describeConnectionFailure(refused, config()).kind).toBe('unreachable');
    expect(describeConnectionFailure(rejected, config()).kind).toBe('auth');
    expect(describeConnectionFailure(refused, config()).summary).not.toBe(
      describeConnectionFailure(rejected, config()).summary
    );
  });
});
