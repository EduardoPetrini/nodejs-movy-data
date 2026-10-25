export interface IDbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  release(err?: Error): void;
}

export interface IDatabaseConnection {
  connect(): Promise<void>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  getClient(): Promise<IDbClient>;
  end(): Promise<void>;
  /**
   * For a caller that has stopped waiting: interrupt every statement still in
   * flight on the SERVER, then close. `end()` alone is not that — a pool's end
   * waits for its busy clients, so a query blocked on a lock outlives it.
   * Optional; an adapter without it is closed with `end()`.
   */
  abort?(): Promise<void>;
}
