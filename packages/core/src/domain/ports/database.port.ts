export interface IDbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  release(err?: Error): void;
}

export interface IDatabaseConnection {
  connect(): Promise<void>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  getClient(): Promise<IDbClient>;
  end(): Promise<void>;
}
