import { Client, Pool, PoolClient, type ClientConfig } from 'pg';
import { IDatabaseConnection, IDbClient } from '../../../domain/ports/database.port.js';
import { ConnectionConfig } from '../../../domain/types/connection.types.js';
import { ConnectionError } from '../../../domain/errors/migration.errors.js';

/** How long `abort()` spends reaching the server to cancel one statement. */
const CANCEL_TIMEOUT_MS = 5000;

export class PgConnection implements IDatabaseConnection {
  private pool: Pool;
  private readonly clientConfig: ClientConfig;
  /** Clients checked out of the pool right now — the ones a statement may be running on. */
  private readonly checkedOut = new Set<PoolClient>();
  private ending: Promise<void> | null = null;

  constructor(config: ConnectionConfig) {
    this.clientConfig = {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      ...(config.ssl === undefined ? {} : { ssl: config.ssl }),
    };
    this.pool = new Pool({
      ...this.clientConfig,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    this.pool.on('acquire', (client) => this.checkedOut.add(client));
    this.pool.on('release', (_err, client) => this.checkedOut.delete(client));
    this.pool.on('remove', (client) => this.checkedOut.delete(client));
  }

  async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      client.release();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConnectionError(`Failed to connect: ${message}`);
    }
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      const result = await this.pool.query(sql, params as unknown[]);
      return result.rows as T[];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConnectionError(`Query failed: ${message}`);
    }
  }

  /**
   * Returns a generic IDbClient wrapping a pg PoolClient.
   * Used by PgSchemaSynchronizer for transactional DDL.
   */
  async getClient(): Promise<IDbClient> {
    try {
      const pgClient = await this.pool.connect();
      return wrapPgClient(pgClient);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConnectionError(`Failed to acquire client: ${message}`);
    }
  }

  /**
   * Returns the raw pg PoolClient for PG-specific streaming operations
   * (e.g. pg-copy-streams). Only use where PG-specific behaviour is required.
   */
  async getPoolClient(): Promise<PoolClient> {
    try {
      return await this.pool.connect();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConnectionError(`Failed to acquire client: ${message}`);
    }
  }

  /** Idempotent: pg-pool rejects a second `end()`, and an abort and a `finally` may both call it. */
  end(): Promise<void> {
    this.ending ??= this.pool.end();
    return this.ending;
  }

  /**
   * Cancels every statement running on a checked-out client, then ends the
   * pool. `pool.end()` waits for busy clients, so without the cancel a
   * catalogue query blocked on a lock kept its backend — and the pool —
   * alive long after anyone wanted the answer.
   *
   * Cancelled with `pg_cancel_backend` on a connection of its own, as the same
   * role. The cancelled statement fails, its client is released, and the end
   * completes. Does not wait for the end: a server that cannot be reached for
   * the cancel cannot be reached for anything else either.
   */
  async abort(): Promise<void> {
    const busy = [...this.checkedOut];
    await Promise.all(busy.map((client) => this.cancelBackend(client)));
    void this.end().catch(() => {});
  }

  private async cancelBackend(client: PoolClient): Promise<void> {
    // node-pg sets it from BackendKeyData; @types/pg does not declare it.
    const pid = (client as PoolClient & { processID?: number | null }).processID;
    if (!pid) return;
    const canceller = new Client({
      ...this.clientConfig,
      connectionTimeoutMillis: CANCEL_TIMEOUT_MS,
      query_timeout: CANCEL_TIMEOUT_MS,
    });
    // An error on an idle canceller must not become an unhandled 'error' event.
    canceller.on('error', () => {});
    try {
      await canceller.connect();
      await canceller.query('SELECT pg_cancel_backend($1)', [pid]);
    } catch {
      // Best effort: the caller has stopped waiting whatever happens here.
    } finally {
      await canceller.end().catch(() => {});
    }
  }
}

function wrapPgClient(pgClient: PoolClient): IDbClient {
  return {
    query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      const result = await pgClient.query(sql, params as unknown[]);
      return result.rows as T[];
    },
    release: (err?: Error) => pgClient.release(err),
  };
}
