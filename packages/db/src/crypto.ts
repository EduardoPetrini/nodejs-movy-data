import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Connection passwords, encrypted at rest.
 *
 * Here rather than in the web app because the runner agent will decrypt the
 * specs it claims (docs/runner-service-plan.md). Both read the same key.
 *
 * Layout: iv(12) || authTag(16) || ciphertext, one bytea column — atomic, so a
 * partial update cannot leave an undecryptable row.
 *
 * The additional authenticated data binds a ciphertext to one org AND one
 * connection row. Moving bytes between rows, or between orgs, fails
 * authentication instead of silently decrypting.
 */
export function secretAad(orgId: string, connectionId: string): Buffer {
  return Buffer.from(`org:${orgId}:connection:${connectionId}`, 'utf8');
}

function key(): Buffer {
  const raw = process.env.NUXT_ENCRYPTION_KEY ?? '';
  if (!raw) throw new Error('NUXT_ENCRYPTION_KEY is not set.');

  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === KEY_BYTES) return decoded;

  throw new Error(
    `NUXT_ENCRYPTION_KEY must be ${KEY_BYTES} bytes of base64 (openssl rand -base64 32); got ${decoded.length}.`
  );
}

export function encryptSecret(plaintext: string, aad: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(packed: Buffer, aad: Buffer): string {
  if (packed.length < IV_BYTES + TAG_BYTES) throw new Error('Stored secret is malformed.');

  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Fails fast at boot rather than at the first save. */
export function assertEncryptionKeyConfigured(): void {
  key();
}
