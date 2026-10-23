import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export interface CreateDbOptions {
  /** Pool size. The web console has used 10 since Phase 1. */
  max?: number;
}

/**
 * A client for the metadata database — Movy's own, never one being migrated.
 *
 * A factory, not a singleton: the web console wraps it in `useDb()`, which reads
 * Nuxt's runtime config, and the runner agent will build its own from the
 * environment. Neither should have to know how the other finds its URL.
 */
export function createDb(url: string, options: CreateDbOptions = {}) {
  const pool = new pg.Pool({ connectionString: url, max: options.max ?? 10 });
  return { pool, db: drizzle(pool, { schema }) };
}

export type Db = ReturnType<typeof createDb>['db'];
export { schema };
