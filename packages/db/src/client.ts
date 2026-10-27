import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export interface CreateDbOptions {
  /** Pool size. The web console has used 10 since Phase 1. */
  max?: number;
  /**
   * Give up on a query that has had no answer for this long. Off by default.
   * A runner agent sets it: a query sent on a socket that died in a network
   * partition otherwise waits forever, and the agent with it.
   */
  queryTimeoutMs?: number;
  /** Give up on opening a connection after this long. Off by default. */
  connectTimeoutMs?: number;
}

/**
 * A client for the metadata database — Movy's own, never one being migrated.
 *
 * A factory, not a singleton: the web console wraps it in `useDb()`, which reads
 * Nuxt's runtime config, and the runner agent will build its own from the
 * environment. Neither should have to know how the other finds its URL.
 */
export function createDb(url: string, options: CreateDbOptions = {}) {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    // TCP keepalive notices a peer that vanished without a FIN.
    keepAlive: true,
    ...(options.queryTimeoutMs ? { query_timeout: options.queryTimeoutMs } : {}),
    ...(options.connectTimeoutMs ? { connectionTimeoutMillis: options.connectTimeoutMs } : {}),
  });
  return { pool, db: drizzle(pool, { schema }) };
}

export type Db = ReturnType<typeof createDb>['db'];
export { schema };
