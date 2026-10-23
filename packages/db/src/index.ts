export * from './schema';
export { createDb, schema, type CreateDbOptions, type Db } from './client';
// Re-exported from the root as well as `@movy/db/crypto`: the runner builds with
// node10 resolution, which cannot see a package's subpath exports.
export { specAad, encryptSecret, decryptSecret, assertEncryptionKeyConfigured } from './crypto';
