import { describe, it, expect } from 'vitest';
import {
  MigrationError,
  ConnectionError,
  SchemaInspectionError,
  SchemaSyncError,
  DataMigrationError,
  CustomTypeError,
  UnsupportedDatabaseError,
} from '../../../src/domain/errors/migration.errors';
import { DatabaseType } from '../../../src/domain/types/connection.types';

describe('MigrationError', () => {
  it('sets message and name', () => {
    const err = new MigrationError('something went wrong');
    expect(err.message).toBe('something went wrong');
    expect(err.name).toBe('MigrationError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ConnectionError', () => {
  it('is a MigrationError', () => {
    const err = new ConnectionError('cannot connect');
    expect(err.name).toBe('ConnectionError');
    expect(err).toBeInstanceOf(MigrationError);
  });
});

describe('SchemaInspectionError', () => {
  it('is a MigrationError', () => {
    const err = new SchemaInspectionError('bad schema');
    expect(err.name).toBe('SchemaInspectionError');
    expect(err).toBeInstanceOf(MigrationError);
  });
});

describe('SchemaSyncError', () => {
  it('is a MigrationError', () => {
    const err = new SchemaSyncError('sync failed');
    expect(err.name).toBe('SchemaSyncError');
    expect(err).toBeInstanceOf(MigrationError);
  });
});

describe('DataMigrationError', () => {
  it('is a MigrationError', () => {
    const err = new DataMigrationError('data copy failed');
    expect(err.name).toBe('DataMigrationError');
    expect(err).toBeInstanceOf(MigrationError);
  });
});

describe('CustomTypeError', () => {
  it('includes the type name in the message', () => {
    const err = new CustomTypeError('my_enum');
    expect(err.name).toBe('CustomTypeError');
    expect(err.message).toContain('my_enum');
    expect(err.message).toContain('v1');
    expect(err).toBeInstanceOf(MigrationError);
  });
});

describe('UnsupportedDatabaseError', () => {
  it('includes the requested type and available types', () => {
    const err = new UnsupportedDatabaseError(DatabaseType.MYSQL, [DatabaseType.POSTGRES]);
    expect(err.name).toBe('UnsupportedDatabaseError');
    expect(err.message).toContain('mysql');
    expect(err.message).toContain('postgres');
    expect(err).toBeInstanceOf(MigrationError);
  });

  it('includes planned version for mysql', () => {
    const err = new UnsupportedDatabaseError(DatabaseType.MYSQL, [DatabaseType.POSTGRES]);
    expect(err.message).toContain('v2');
  });

  it('includes planned version for mssql', () => {
    const err = new UnsupportedDatabaseError(DatabaseType.MSSQL, [DatabaseType.POSTGRES]);
    expect(err.message).toContain('v3');
  });

  it('includes planned version for snowflake', () => {
    const err = new UnsupportedDatabaseError(DatabaseType.SNOWFLAKE, [DatabaseType.POSTGRES]);
    expect(err.message).toContain('v3');
  });
});
