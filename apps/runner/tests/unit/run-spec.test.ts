import { Readable } from 'stream';
import { describe, expect, test } from 'vitest';
import { DatabaseType } from '@movy/core';
import { RunSpecError, parseRunSpec, readRunSpec } from '../../src/run-spec';

const PASSWORD = 'hunter2-do-not-leak';

function validSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: '75a5723e-7eb4-4f14-a3c6-68fdbc50721f',
    mode: 'full',
    source: {
      type: 'postgres',
      host: 'db.internal',
      port: 5432,
      user: 'movy',
      password: PASSWORD,
      database: 'movy_fixture_src',
    },
    target: {
      type: 'mysql',
      host: 'db2.internal',
      port: 3306,
      user: 'movy',
      password: PASSWORD,
      database: 'movy_fixture_dst',
    },
    ...overrides,
  };
}

describe('parseRunSpec', () => {
  test('parses a complete spec', () => {
    const spec = parseRunSpec(JSON.stringify(validSpec()));

    expect(spec.runId).toBe('75a5723e-7eb4-4f14-a3c6-68fdbc50721f');
    expect(spec.mode).toBe('full');
    expect(spec.source.type).toBe(DatabaseType.POSTGRES);
    expect(spec.target.type).toBe(DatabaseType.MYSQL);
    expect(spec.source.password).toBe(PASSWORD);
  });

  test('carries optional ssl and schema through when present', () => {
    const raw = validSpec();
    (raw.source as Record<string, unknown>).ssl = { rejectUnauthorized: false };
    (raw.source as Record<string, unknown>).schema = 'reporting';

    const spec = parseRunSpec(JSON.stringify(raw));

    expect(spec.source.ssl).toEqual({ rejectUnauthorized: false });
    expect(spec.source.schema).toBe('reporting');
  });

  test('omits ssl and schema entirely when absent, rather than setting undefined', () => {
    const spec = parseRunSpec(JSON.stringify(validSpec()));

    expect('ssl' in spec.source).toBe(false);
    expect('schema' in spec.source).toBe(false);
  });

  test('drops unknown keys instead of passing them to a driver', () => {
    const raw = validSpec();
    (raw.source as Record<string, unknown>).connectionString = 'postgres://evil';

    const spec = parseRunSpec(JSON.stringify(raw));

    expect('connectionString' in spec.source).toBe(false);
  });

  test('allows an empty password for trusted-auth setups', () => {
    const raw = validSpec();
    (raw.source as Record<string, unknown>).password = '';

    expect(parseRunSpec(JSON.stringify(raw)).source.password).toBe('');
  });

  test('rejects query mode, which emits no progress and cannot be timelined', () => {
    expect(() => parseRunSpec(JSON.stringify(validSpec({ mode: 'query' })))).toThrow(
      /spec.mode must be "full"/
    );
  });

  test('rejects an unsupported engine', () => {
    const raw = validSpec();
    (raw.source as Record<string, unknown>).type = 'oracle';

    expect(() => parseRunSpec(JSON.stringify(raw))).toThrow(/spec.source.type/);
  });

  test('rejects a port outside the valid range', () => {
    const raw = validSpec();
    (raw.target as Record<string, unknown>).port = 70000;

    expect(() => parseRunSpec(JSON.stringify(raw))).toThrow(/spec.target.port/);
  });

  test('rejects a missing runId', () => {
    const raw = validSpec();
    delete raw.runId;

    expect(() => parseRunSpec(JSON.stringify(raw))).toThrow(/spec.runId/);
  });

  test('rejects malformed JSON without quoting it back', () => {
    expect(() => parseRunSpec('{"runId":')).toThrow(RunSpecError);
    expect(() => parseRunSpec('{"runId":')).toThrow(/not valid JSON/);
  });

  // The single most important property here: this message is written to stderr
  // and sent to the host as a `fatal`, so it must never carry a credential.
  test('never echoes a password in a validation error', () => {
    const raw = validSpec();
    (raw.source as Record<string, unknown>).port = 'five thousand';

    let message = '';
    try {
      parseRunSpec(JSON.stringify(raw));
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toMatch(/spec.source.port/);
    expect(message).not.toContain(PASSWORD);
  });

  test('never echoes a password when the whole payload is the wrong shape', () => {
    let message = '';
    try {
      parseRunSpec(JSON.stringify([validSpec()]));
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).not.toContain(PASSWORD);
  });
});

describe('readRunSpec', () => {
  test('reads a spec written across several chunks', async () => {
    const json = JSON.stringify(validSpec());
    const stream = Readable.from([json.slice(0, 20), json.slice(20)]);

    const spec = await readRunSpec(stream, 1000);

    expect(spec.runId).toBe('75a5723e-7eb4-4f14-a3c6-68fdbc50721f');
  });

  test('times out when the host dies between fork and write', async () => {
    // Never emits 'end' — exactly what a half-open pipe to a dead host looks like.
    const stream = new Readable({ read() {} });

    await expect(readRunSpec(stream, 20)).rejects.toThrow(/no run spec on stdin within 20ms/);
  });

  test('surfaces a stream error as a spec error', async () => {
    const stream = new Readable({ read() {} });
    setTimeout(() => stream.emit('error', new Error('EPIPE')), 5);

    await expect(readRunSpec(stream, 1000)).rejects.toThrow(/could not read run spec/);
  });
});
