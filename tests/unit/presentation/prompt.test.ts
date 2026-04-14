import { describe, expect, it } from 'vitest';
import {
  formatConnectionSummary,
  getDefaultPort,
  maskSecret,
  parseDatabaseType,
} from '../../../src/presentation/cli/prompt';
import { DatabaseType } from '../../../src/domain/types/connection.types';

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
      {
        type: DatabaseType.POSTGRES,
        host: '127.0.0.1',
        port: 5432,
        user: 'postgres',
        password: 'secret-value',
        database: 'movy',
      },
      'prompt'
    );

    expect(summary).toContain('Source');
    expect(summary).toContain('127.0.0.1');
    expect(summary).toContain('********');
    expect(summary).not.toContain('secret-value');
  });
});
