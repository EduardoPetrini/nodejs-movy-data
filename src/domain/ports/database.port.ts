import { PoolClient } from 'pg';

export interface IDatabaseConnection {
  connect(): Promise<void>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  getClient(): Promise<PoolClient>;
  end(): Promise<void>;
}
