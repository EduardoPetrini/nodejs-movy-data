import { createDb, schema } from '@movy/db';
import type { Db as MetaDb } from '@movy/db';

let db: MetaDb | undefined;

/**
 * The metadata database — Movy's own, never one being migrated.
 *
 * Handlers must NOT import this directly; an ESLint rule forbids it. Use
 * createRepos(event), whose repositories are bound to one org id, so a query
 * cannot be written that forgets its org scope.
 */
export function useDb(): MetaDb {
  if (!db) db = createDb(metaDatabaseUrl(), { max: 10 }).db;
  return db;
}

/** The metadata database URL — also what the LISTEN connection, outside the pool, dials. */
export function metaDatabaseUrl(): string {
  const url = process.env.NUXT_DATABASE_URL ?? useRuntimeConfig().databaseUrl;
  if (!url) throw new Error('NUXT_DATABASE_URL is not set.');
  return url;
}

export type Db = ReturnType<typeof useDb>;
export { schema };
