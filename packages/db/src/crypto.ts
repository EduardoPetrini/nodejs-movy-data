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

/**
 * A run's sealed specification, bound to its org and its run the same way a
 * connection secret is bound to its row: a spec lifted onto another run, or
 * into another org, fails authentication instead of starting a migration.
 */
export function specAad(orgId: string, runId: string): Buffer {
  return Buffer.from(`org:${orgId}:run-spec:${runId}`, 'utf8');
}

/** A probe's sealed request, bound the same way: to its org and its probe. */
export function probeAad(orgId: string, probeId: string): Buffer {
  return Buffer.from(`org:${orgId}:probe:${probeId}`, 'utf8');
}

/**
 * MOVY_ENCRYPTION_KEY first: a runner agent is not a Nuxt process, and naming
 * its key after the framework of a different service would be a trap. The web
 * console keeps reading NUXT_ENCRYPTION_KEY, so neither deployment changes.
 */
function key(): Buffer {
  const raw = process.env.MOVY_ENCRYPTION_KEY || process.env.NUXT_ENCRYPTION_KEY || '';
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
