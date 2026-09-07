import mysql from 'mysql2/promise';
import { IDatabaseConnection, IDbClient } from '../../../domain/ports/database.port';
import { ConnectionConfig } from '../../../domain/types/connection.types';
import { ConnectionError } from '../../../domain/errors/migration.errors';

export class MysqlConnection implements IDatabaseConnection {
  private pool: mysql.Pool;

  constructor(config: ConnectionConfig) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database || undefined,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 5000,
    });
  }

  async connect(): Promise<void> {
    try {
      const conn = await this.pool.getConnection();
      conn.release();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConnectionError(`Failed to connect: ${message}`);
    }
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [rows] = await this.pool.execute(sql, (params ?? []) as any);
      return rows as T[];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConnectionError(`Query failed: ${message}`);
    }
  }

  async getClient(): Promise<IDbClient> {
    try {
      const conn = await this.pool.getConnection();
      return {
        query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const [rows] = await conn.execute(sql, (params ?? []) as any);
          return rows as T[];
        },
        release: () => conn.release(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConnectionError(`Failed to acquire client: ${message}`);
    }
  }

  /**
   * Returns the raw mysql2 Pool for streaming operations.
   */
  getPool(): mysql.Pool {
    return this.pool;
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
