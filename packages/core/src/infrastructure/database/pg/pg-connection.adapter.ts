import { Pool, PoolClient } from 'pg';
import { IDatabaseConnection, IDbClient } from '../../../domain/ports/database.port';
import { ConnectionConfig } from '../../../domain/types/connection.types';
import { ConnectionError } from '../../../domain/errors/migration.errors';

export class PgConnection implements IDatabaseConnection {
  private pool: Pool;

  constructor(config: ConnectionConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
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

  async end(): Promise<void> {
    await this.pool.end();
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
