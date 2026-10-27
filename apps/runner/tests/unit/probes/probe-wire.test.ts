import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { DatabaseType, type ConnectionConfig } from '@movy/core';

vi.mock('../../../src/probes/test-connection', () => ({
  testConnection: vi.fn(async () => ({ ok: true, latencyMs: 4 })),
}));
vi.mock('../../../src/probes/inspect-for-preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/probes/inspect-for-preview')>();
  return { ...actual, inspectForPreview: vi.fn() };
});

import { inspectForPreview, PreviewConnectionError } from '../../../src/probes/inspect-for-preview';
import {
  PROBE_VERSION, ProbeIncompatibleError, executeProbe, openProbe, readProbeResult, sealProbe, type ProbeRequest,
} from '../../../src/probes/probe-wire';
import { encryptSecret, probeAad } from '@movy/db';

const ORG = '11111111-1111-1111-1111-111111111111';
const PROBE = '22222222-2222-2222-2222-222222222222';

const config = (password: string): ConnectionConfig => ({
  type: DatabaseType.POSTGRES, host: 'pg', port: 5432, user: 'u', password, database: 'shop',
});

beforeAll(() => {
  process.env.NUXT_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

describe('sealProbe / openProbe', () => {
  it('round-trips a request without its password showing in the ciphertext', () => {
    const request: ProbeRequest = { kind: 'test', config: config('hunter2') };
    const sealed = sealProbe(ORG, PROBE, request);
    expect(sealed.toString('utf8')).not.toContain('hunter2');
    expect(openProbe(ORG, PROBE, sealed)).toEqual(request);
  });

  it('refuses a request sealed for another probe or another org', () => {
    const sealed = sealProbe(ORG, PROBE, { kind: 'test', config: config('hunter2') });
    expect(() => openProbe(ORG, '33333333-3333-3333-3333-333333333333', sealed)).toThrow();
    expect(() => openProbe('44444444-4444-4444-4444-444444444444', PROBE, sealed)).toThrow();
  });

  it('refuses a version it does not understand, by name', () => {
    const sealed = encryptSecret(JSON.stringify({ v: PROBE_VERSION + 1, request: {} }), probeAad(ORG, PROBE));
    expect(() => openProbe(ORG, PROBE, sealed)).toThrow(ProbeIncompatibleError);
  });

  it('refuses a request of a kind it does not know, rather than running it as a preview', () => {
    const sealed = encryptSecret(JSON.stringify({ v: PROBE_VERSION, request: { kind: 'drop' } }), probeAad(ORG, PROBE));
    expect(() => openProbe(ORG, PROBE, sealed)).toThrow(ProbeIncompatibleError);
  });

  it('refuses a request missing the connection it names', () => {
    const sealed = encryptSecret(
      JSON.stringify({ v: PROBE_VERSION, request: { kind: 'preview', source: config('pw-1234') } }),
      probeAad(ORG, PROBE)
    );
    expect(() => openProbe(ORG, PROBE, sealed)).toThrow(ProbeIncompatibleError);
  });
});

describe('readProbeResult', () => {
  // A runner's answer is stored by the shared `movy_runner` role and served
  // to a browser: only the fields the console knows survive.
  it('keeps a test result\'s own fields and nothing else', () => {
    expect(readProbeResult('test', { ok: false, latencyMs: 9, error: 'Rejected.', errorKind: 'auth', extra: '<script>' }))
      .toEqual({ ok: false, latencyMs: 9, error: 'Rejected.', errorKind: 'auth' });
  });

  it('turns a test result of the wrong shape into a failure that says so', () => {
    const result = readProbeResult('test', { ok: 'yes', latencyMs: 'fast' });
    expect(result).toMatchObject({ ok: false, errorKind: 'unknown' });
    expect(result).not.toHaveProperty('extra');
  });

  it('refuses an error kind the console does not know', () => {
    expect(readProbeResult('test', { ok: false, latencyMs: 1, error: 'x', errorKind: 'catastrophe' }))
      .toMatchObject({ ok: false, errorKind: 'unknown' });
  });

  it('keeps a preview inspection and a preview failure', () => {
    const inspection = {
      targetDatabaseExists: true, sourceSchema: {}, targetSchema: {}, diff: {}, plan: {}, rowEstimates: [], sizeEstimates: [],
    };
    expect(readProbeResult('preview', { ok: true, inspection })).toEqual({ ok: true, inspection });
    expect(readProbeResult('preview', { ok: false, side: 'source', errorKind: 'auth', message: 'Rejected.', extra: 1 }))
      .toEqual({ ok: false, side: 'source', errorKind: 'auth', message: 'Rejected.' });
  });

  it('turns a preview of the wrong shape, or a test result answering a preview, into a failure', () => {
    expect(readProbeResult('preview', { ok: true, latencyMs: 4 })).toMatchObject({ ok: false, side: null, errorKind: 'unknown' });
    expect(readProbeResult('preview', null)).toMatchObject({ ok: false, side: null, errorKind: 'unknown' });
  });
});

describe('executeProbe', () => {
  it('runs a test through the shared executor', async () => {
    expect(await executeProbe({ kind: 'test', config: config('pw-1234') })).toEqual({ ok: true, latencyMs: 4 });
  });

  it('returns a preview inspection as data', async () => {
    const inspection = { targetDatabaseExists: true, rowEstimates: [['t', 1]] };
    vi.mocked(inspectForPreview).mockResolvedValueOnce(inspection as never);
    expect(
      await executeProbe({ kind: 'preview', source: config('src-pw-1'), target: config('dst-pw-1') })
    ).toEqual({ ok: true, inspection });
  });

  it('names the end that could not be reached', async () => {
    vi.mocked(inspectForPreview).mockRejectedValueOnce(
      new PreviewConnectionError('destination', 'auth', 'The username or password was rejected.')
    );
    expect(
      await executeProbe({ kind: 'preview', source: config('src-pw-1'), target: config('dst-pw-1') })
    ).toEqual({ ok: false, side: 'destination', errorKind: 'auth', message: 'The username or password was rejected.' });
  });

  it('never throws, and strips both passwords from an unexpected failure', async () => {
    vi.mocked(inspectForPreview).mockRejectedValueOnce(new Error('boom near src-pw-1 and dst-pw-1'));
    const result = await executeProbe({ kind: 'preview', source: config('src-pw-1'), target: config('dst-pw-1') });
    expect(result).toMatchObject({ ok: false, side: null, errorKind: 'unknown' });
    expect(JSON.stringify(result)).not.toMatch(/src-pw-1|dst-pw-1/);
  });
});
