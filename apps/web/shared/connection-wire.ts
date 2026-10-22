/**
 * The connection contract, declared once for both halves.
 *
 * Same reasoning as `run-wire.ts` and `definition-wire.ts`: the serializer's
 * return type is annotated with `WireConnection`, so a field the server stops
 * sending is a type error in the client rather than `undefined` on a screen
 * where someone is about to point a migration at a database.
 *
 * There is deliberately no `password` and no `secret` here. A connection's
 * password travels in exactly one direction — client to server, on create and
 * on edit — and `ConnectionInput` is the only shape that carries it.
 */

export interface WireConnectionTest {
  at: string;
  ok: boolean;
  latencyMs: number | null;
  /** Already scrubbed by `describeConnectionFailure`; safe to render. */
  error: string | null;
}

export interface WireConnection {
  id: string;
  name: string;
  engine: string;
  database: string;
  schemaName: string;
  /** Always true. The stored password is never serialised, only acknowledged. */
  hasSecret: true;
  createdAt: string;
  updatedAt: string;
  lastTest: WireConnectionTest | null;
  /** Present for editor and admin only. Viewers do not see connection targets. */
  host?: string;
  port?: number;
  username?: string;
  ssl?: boolean;
}

/**
 * What the create and edit forms send.
 *
 * `password` is optional because an edit that leaves it blank means "keep the
 * stored one" — the form has no value to prefill it with, and a blank field
 * must never be read as "clear the credential".
 */
export interface ConnectionInput {
  name: string;
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
  schemaName: string;
  ssl: boolean;
}

export interface ConnectionEngine {
  value: string;
  label: string;
  /** Offered when the engine is chosen, never forced over a typed port. */
  defaultPort: number;
}

/**
 * The engines a connection can be saved for.
 *
 * Three, not the four `parseEngine` accepts: Snowflake has a `DatabaseType` but
 * no registered Adapter Set, so offering it here would save a connection that
 * fails on the first step of every run.
 */
export const CONNECTION_ENGINES: readonly ConnectionEngine[] = [
  { value: 'postgres', label: 'PostgreSQL', defaultPort: 5432 },
  { value: 'mysql', label: 'MySQL', defaultPort: 3306 },
  { value: 'mssql', label: 'SQL Server', defaultPort: 1433 },
];

export function defaultPortFor(engine: string): number | undefined {
  return CONNECTION_ENGINES.find((e) => e.value === engine)?.defaultPort;
}
