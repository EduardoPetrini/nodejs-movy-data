import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptSecret, decryptSecret, secretAad, assertEncryptionKeyConfigured,
  hashLocalPassword, verifyLocalPassword,
} from '../../server/utils/crypto';

beforeAll(() => {
  process.env.NUXT_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const CONN_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONN_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('connection secrets', () => {
  it('round-trips a password', () => {
    const aad = secretAad(ORG_A, CONN_1);
    expect(decryptSecret(encryptSecret('hunter2', aad), aad)).toBe('hunter2');
  });

  it('never stores the plaintext in the packed bytes', () => {
    const packed = encryptSecret('hunter2', secretAad(ORG_A, CONN_1));
    expect(packed.toString('utf8')).not.toContain('hunter2');
    expect(packed.toString('base64')).not.toContain(Buffer.from('hunter2').toString('base64'));
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const aad = secretAad(ORG_A, CONN_1);
    expect(encryptSecret('same', aad).equals(encryptSecret('same', aad))).toBe(false);
  });

  it('refuses a ciphertext lifted into another org', () => {
    // The whole point of binding org id into the AAD: copying bytes across
    // tenants must fail authentication, not silently decrypt.
    const packed = encryptSecret('hunter2', secretAad(ORG_A, CONN_1));
    expect(() => decryptSecret(packed, secretAad(ORG_B, CONN_1))).toThrow();
  });

  it('refuses a ciphertext lifted into another connection in the same org', () => {
    const packed = encryptSecret('hunter2', secretAad(ORG_A, CONN_1));
    expect(() => decryptSecret(packed, secretAad(ORG_A, CONN_2))).toThrow();
  });

  it('refuses a tampered ciphertext', () => {
    const aad = secretAad(ORG_A, CONN_1);
    const packed = encryptSecret('hunter2', aad);
    packed[packed.length - 1] ^= 0xff;
    expect(() => decryptSecret(packed, aad)).toThrow();
  });

  it('rejects a truncated payload rather than reading out of bounds', () => {
    expect(() => decryptSecret(Buffer.alloc(4), secretAad(ORG_A, CONN_1))).toThrow(/malformed/i);
  });
});

describe('assertEncryptionKeyConfigured', () => {
  it('fails at boot on a missing or wrong-length key, not at first save', () => {
    const good = process.env.NUXT_ENCRYPTION_KEY;

    process.env.NUXT_ENCRYPTION_KEY = '';
    expect(() => assertEncryptionKeyConfigured()).toThrow(/not set/i);

    process.env.NUXT_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64');
    expect(() => assertEncryptionKeyConfigured()).toThrow(/32 bytes/i);

    process.env.NUXT_ENCRYPTION_KEY = good;
    expect(() => assertEncryptionKeyConfigured()).not.toThrow();
  });
});

describe('development passwords', () => {
  it('verifies a correct password and rejects a wrong one', () => {
    const stored = hashLocalPassword('correct horse');
    expect(verifyLocalPassword('correct horse', stored)).toBe(true);
    expect(verifyLocalPassword('wrong horse', stored)).toBe(false);
  });

  it('salts, so the same password hashes differently each time', () => {
    expect(hashLocalPassword('same')).not.toBe(hashLocalPassword('same'));
  });

  it('rejects a malformed stored value instead of throwing', () => {
    expect(verifyLocalPassword('x', 'garbage')).toBe(false);
    expect(verifyLocalPassword('x', '')).toBe(false);
  });
});
