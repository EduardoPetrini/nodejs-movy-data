import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Connection secrets live in @movy/db, which the runner agent shares. Re-exported
// so the web app's imports stay where they were.
export { secretAad, encryptSecret, decryptSecret, assertEncryptionKeyConfigured } from '@movy/db/crypto';

const SCRYPT = { N: 16384, r: 8, p: 1 };

/** Development-only local passwords. Node's stdlib, matching this repo's low-dependency leaning. */
export function hashLocalPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyLocalPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;

  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
