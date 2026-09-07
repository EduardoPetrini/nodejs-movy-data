import { DatabaseType, type ConnectionConfig } from '@movy/core';
import type { ConnectionRow } from '../repositories/connections.repo';
import { decryptSecret, secretAad } from './crypto';

const ENGINES: Record<string, DatabaseType> = {
  postgres: DatabaseType.POSTGRES,
  mysql: DatabaseType.MYSQL,
  mssql: DatabaseType.MSSQL,
  snowflake: DatabaseType.SNOWFLAKE,
};

export function parseEngine(value: string): DatabaseType {
  const engine = ENGINES[value?.toLowerCase()];
  if (!engine) {
    throw createError({ statusCode: 400, statusMessage: `Unknown engine "${value}".` });
  }
  return engine;
}

/**
 * Decrypt a saved connection into a usable config.
 *
 * One of only two places a password is ever decrypted (the other is launching a
 * run). The result must never reach a response body.
 */
export function toConnectionConfig(row: ConnectionRow, overrideDatabase?: string): ConnectionConfig {
  return {
    type: parseEngine(row.engine),
    host: row.host,
    port: row.port,
    user: row.username,
    password: decryptSecret(row.secret, secretAad(row.orgId, row.id)),
    database: overrideDatabase ?? row.database,
    ssl: row.ssl ? { rejectUnauthorized: false } : undefined,
  };
}
