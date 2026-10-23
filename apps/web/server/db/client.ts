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
  if (!db) {
    const url = process.env.NUXT_DATABASE_URL ?? useRuntimeConfig().databaseUrl;
    if (!url) throw new Error('NUXT_DATABASE_URL is not set.');
    db = createDb(url, { max: 10 }).db;
  }
  return db;
}

export type Db = ReturnType<typeof useDb>;
export { schema };
