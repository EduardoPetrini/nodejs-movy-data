import type { ConnectionRow } from '../repositories/connections.repo';
import type { OrgRole } from '../db/schema';

/**
 * What a client is allowed to see of a connection.
 *
 * Built up, never torn down: there is no `delete row.secret` anywhere, because
 * a field that is never copied cannot be forgotten. `secret` has no branch that
 * emits it — decryption happens only when opening a connection, server-side.
 */
export interface PublicConnection {
  id: string;
  name: string;
  engine: string;
  database: string;
  schemaName: string;
  hasSecret: true;
  createdAt: string;
  updatedAt: string;
  lastTest: { at: string; ok: boolean; latencyMs: number | null; error: string | null } | null;
  /** Present for editor and admin only. Viewers do not see connection targets. */
  host?: string;
  port?: number;
  username?: string;
  ssl?: boolean;
}

export function toPublicConnection(row: ConnectionRow, role: OrgRole): PublicConnection {
  const base: PublicConnection = {
    id: row.id,
    name: row.name,
    engine: row.engine,
    database: row.database,
    schemaName: row.schemaName,
    hasSecret: true,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastTest: row.lastTestAt
      ? {
          at: row.lastTestAt.toISOString(),
          ok: row.lastTestOk ?? false,
          latencyMs: row.lastTestLatencyMs,
          error: row.lastTestError,
        }
      : null,
  };

  if (role === 'viewer') return base;

  return { ...base, host: row.host, port: row.port, username: row.username, ssl: row.ssl };
}
