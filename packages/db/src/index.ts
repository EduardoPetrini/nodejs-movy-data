export * from './schema';
export { createDb, schema, type CreateDbOptions, type Db } from './client';
// Re-exported from the root as well as `@movy/db/crypto`: the runner builds with
// node10 resolution, which cannot see a package's subpath exports.
export { specAad, probeAad, encryptSecret, decryptSecret, assertEncryptionKeyConfigured } from './crypto';
export { RUNNER_ROLE, RUNNER_GRANTS, SCALER_ROLE, ensureRunnerRole, ensureScalerRole } from './runner-role';
