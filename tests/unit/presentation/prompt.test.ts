import { describe, expect, it } from 'vitest';
import {
  formatConnectionSummary,
  getDefaultPort,
  maskSecret,
  parseDatabaseType,
} from '../../../src/presentation/cli/prompt';
import { ConnectionConfig, DatabaseType } from '../../../src/domain/types/connection.types';

const baseConfig: ConnectionConfig = {
  type: DatabaseType.POSTGRES,
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  password: 'secret-value',
  database: 'movy',
};

describe('prompt helpers', () => {
  it('parses supported database aliases', () => {
    expect(parseDatabaseType('PostgreSQL')).toBe(DatabaseType.POSTGRES);
    expect(parseDatabaseType('sqlserver')).toBe(DatabaseType.MSSQL);
    expect(parseDatabaseType('snowflake')).toBe(DatabaseType.SNOWFLAKE);
  });

  it('returns the default port for each database family', () => {
    expect(getDefaultPort(DatabaseType.POSTGRES)).toBe(5432);
    expect(getDefaultPort(DatabaseType.MYSQL)).toBe(3306);
    expect(getDefaultPort(DatabaseType.MSSQL)).toBe(1433);
  });

  it('masks secrets without leaking plaintext values', () => {
    expect(maskSecret('secret-value')).toBe('********');
    expect(maskSecret('')).toBe('(empty)');
  });

  it('formats a connection summary without exposing the raw password', () => {
    const summary = formatConnectionSummary(
      'Source',
      baseConfig,
      new Set<keyof ConnectionConfig>()
    );

    expect(summary).toContain('Source');
    expect(summary).toContain('127.0.0.1');
    expect(summary).toContain('********');
    expect(summary).not.toContain('secret-value');
    expect(summary).toContain('hidden input');
  });

  it('marks env-sourced fields in the connection summary', () => {
    const envSources = new Set<keyof ConnectionConfig>(['host', 'password', 'database']);
    const summary = formatConnectionSummary('Target', baseConfig, envSources);

    expect(summary).toContain('(env)');
    expect(summary).not.toContain('hidden input');
    expect(summary).not.toContain('secret-value');
  });

  it('shows hidden-input note for password when not from env', () => {
    const summary = formatConnectionSummary(
      'Source',
      baseConfig,
      new Set<keyof ConnectionConfig>()
    );
    expect(summary).toContain('hidden input');
    expect(summary).not.toContain('(env)');
  });
});
