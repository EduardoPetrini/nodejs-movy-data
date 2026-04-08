import { DatabaseType } from '../types/connection.types';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export class ConnectionError extends MigrationError {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export class SchemaInspectionError extends MigrationError {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaInspectionError';
  }
}

export class SchemaSyncError extends MigrationError {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaSyncError';
  }
}

export class DataMigrationError extends MigrationError {
  constructor(message: string) {
    super(message);
    this.name = 'DataMigrationError';
  }
}

export class CustomTypeError extends MigrationError {
  constructor(typeName: string) {
    super(
      `Custom type '${typeName}' is not supported in v1. Create it manually on the destination first.`
    );
    this.name = 'CustomTypeError';
  }
}

export class UnsupportedDatabaseError extends MigrationError {
  constructor(requested: DatabaseType, available: DatabaseType[]) {
    const availableList = available.join(', ');
    const versionMap: Partial<Record<DatabaseType, string>> = {
      [DatabaseType.MYSQL]: 'v2',
      [DatabaseType.MSSQL]: 'v3',
      [DatabaseType.SNOWFLAKE]: 'v3',
    };
    const plannedVersion = versionMap[requested];
    const versionNote = plannedVersion
      ? ` Planned for ${plannedVersion}.`
      : '';
    super(
      `Database type '${requested}' adapters are not yet implemented.${versionNote} Available types: ${availableList}.`
    );
    this.name = 'UnsupportedDatabaseError';
  }
}
