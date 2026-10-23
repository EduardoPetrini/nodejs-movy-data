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
  PROBE_VERSION, ProbeIncompatibleError, executeProbe, openProbe, sealProbe, type ProbeRequest,
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
