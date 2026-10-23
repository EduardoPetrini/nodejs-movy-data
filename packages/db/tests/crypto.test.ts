import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, secretAad, specAad } from '../src/crypto';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const RUN_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// Connection secrets are covered by apps/web/tests/unit/crypto.test.ts, which
// imports through the web app's re-export. This file covers what @movy/db adds.
describe('run spec sealing', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { movy: process.env.MOVY_ENCRYPTION_KEY, nuxt: process.env.NUXT_ENCRYPTION_KEY };
    process.env.NUXT_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    delete process.env.MOVY_ENCRYPTION_KEY;
  });
  afterEach(() => {
    process.env.MOVY_ENCRYPTION_KEY = saved.movy;
    process.env.NUXT_ENCRYPTION_KEY = saved.nuxt;
    if (saved.movy === undefined) delete process.env.MOVY_ENCRYPTION_KEY;
  });

  it('round-trips a spec for the run it was sealed for', () => {
    const aad = specAad(ORG_A, RUN_1);
    expect(decryptSecret(encryptSecret('{"spec":1}', aad), aad)).toBe('{"spec":1}');
  });

  it('refuses a spec lifted onto another run, or into another org', () => {
    const packed = encryptSecret('{"spec":1}', specAad(ORG_A, RUN_1));
    expect(() => decryptSecret(packed, specAad(ORG_A, RUN_2))).toThrow();
    expect(() => decryptSecret(packed, specAad(ORG_B, RUN_1))).toThrow();
  });

  it('never accepts a connection secret as a run spec, even with the same ids', () => {
    // The two AADs share their ids by construction; the label is what keeps
    // a ciphertext from one purpose out of the other.
    const packed = encryptSecret('hunter2', secretAad(ORG_A, RUN_1));
    expect(() => decryptSecret(packed, specAad(ORG_A, RUN_1))).toThrow();
  });

  it('reads MOVY_ENCRYPTION_KEY before the web console\'s NUXT_ENCRYPTION_KEY', () => {
    const aad = specAad(ORG_A, RUN_1);
    process.env.MOVY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    const packed = encryptSecret('x', aad);
    delete process.env.MOVY_ENCRYPTION_KEY;
    expect(() => decryptSecret(packed, aad)).toThrow();
  });
});
