import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

let pool: pg.Pool | undefined;
let db: ReturnType<typeof drizzle<typeof schema>> | undefined;

/**
 * The metadata database — Movy's own, never one being migrated.
 *
 * Handlers must NOT import this directly; an ESLint rule forbids it. Use
 * createRepos(event), whose repositories are bound to one org id, so a query
 * cannot be written that forgets its org scope.
 */
export function useDb() {
  if (!db) {
    const url = process.env.NUXT_DATABASE_URL ?? useRuntimeConfig().databaseUrl;
    if (!url) throw new Error('NUXT_DATABASE_URL is not set.');
    pool = new pg.Pool({ connectionString: url, max: 10 });
    db = drizzle(pool, { schema });
  }
  return db;
}

export type Db = ReturnType<typeof useDb>;
export { schema };
