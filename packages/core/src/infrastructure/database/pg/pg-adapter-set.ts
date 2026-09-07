import { DatabaseAdapterSet, ListTablesOptions } from '../registry.js';
import { ConnectionConfig } from '../../../domain/types/connection.types.js';
import { IDatabaseConnection } from '../../../domain/ports/database.port.js';
import { ISchemaInspector } from '../../../domain/ports/schema-inspector.port.js';
import { ISchemaSynchronizer } from '../../../domain/ports/schema-synchronizer.port.js';
import { IDataMigrator } from '../../../domain/ports/data-migrator.port.js';
import { ISchemaTranslator } from '../../../domain/ports/schema-translator.port.js';
import { PgConnection } from './pg-connection.adapter.js';
import { PgSchemaInspector } from './pg-schema-inspector.adapter.js';
import { PgSchemaSynchronizer } from './pg-schema-synchronizer.adapter.js';
import { PgSchemaTranslator } from './pg-schema-translator.adapter.js';
import { PgDataMigrator } from '../../migration/pg-data-migrator.adapter.js';

export class PgAdapterSet implements DatabaseAdapterSet {
  readonly adminDatabase = 'postgres';

  createConnection(config: ConnectionConfig): IDatabaseConnection {
    return new PgConnection(config);
  }

  createSchemaInspector(): ISchemaInspector {
    return new PgSchemaInspector();
  }

  createSchemaSynchronizer(): ISchemaSynchronizer {
    return new PgSchemaSynchronizer();
  }

  createDataMigrator(): IDataMigrator {
    return new PgDataMigrator();
  }

  /** @deprecated Register translators via DatabaseAdapterRegistry.registerTranslator() */
  createSchemaTranslator(): ISchemaTranslator {
    return new PgSchemaTranslator();
  }

  async ensureDatabase(adminConnection: IDatabaseConnection, dbName: string): Promise<boolean> {
    const rows = await adminConnection.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname = $1`,
      [dbName]
    );
    if (rows.length > 0) return false;
    await adminConnection.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    return true;
  }

  async listDatabases(adminConnection: IDatabaseConnection): Promise<string[]> {
    const rows = await adminConnection.query<{ datname: string }>(
      `SELECT datname FROM pg_database
        WHERE datistemplate = false AND datallowconn = true
        ORDER BY datname`
    );
    return rows.map((row) => row.datname);
  }

  async listTables(
    connection: IDatabaseConnection,
    opts: ListTablesOptions = {}
  ): Promise<string[]> {
    const rows = await connection.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
      [opts.schema ?? 'public']
    );
    return rows.map((row) => row.table_name);
  }

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

}
