import { DatabaseAdapterSet, ListTablesOptions } from '../registry';
import { ConnectionConfig } from '../../../domain/types/connection.types';
import { IDatabaseConnection } from '../../../domain/ports/database.port';
import { ISchemaInspector } from '../../../domain/ports/schema-inspector.port';
import { ISchemaSynchronizer } from '../../../domain/ports/schema-synchronizer.port';
import { IDataMigrator } from '../../../domain/ports/data-migrator.port';
import { MssqlConnection } from './mssql-connection.adapter';
import { MssqlSchemaInspector } from './mssql-schema-inspector.adapter';
import { MssqlSchemaSynchronizer } from './mssql-schema-synchronizer.adapter';
import { MssqlDataMigrator } from '../../migration/mssql-data-migrator.adapter';

export class MssqlAdapterSet implements DatabaseAdapterSet {
  readonly adminDatabase = 'master';

  createConnection(config: ConnectionConfig): IDatabaseConnection {
    return new MssqlConnection(config);
  }

  createSchemaInspector(): ISchemaInspector {
    return new MssqlSchemaInspector();
  }

  createSchemaSynchronizer(): ISchemaSynchronizer {
    return new MssqlSchemaSynchronizer();
  }

  createDataMigrator(): IDataMigrator {
    return new MssqlDataMigrator();
  }

  async ensureDatabase(adminConnection: IDatabaseConnection, dbName: string): Promise<boolean> {
    const rows = await adminConnection.query<{ db_count: number }>(
      `SELECT COUNT(*) AS db_count FROM sys.databases WHERE name = ?`,
      [dbName]
    );
    if ((rows[0]?.db_count ?? 0) > 0) return false;
    await adminConnection.query(
      `CREATE DATABASE [${dbName.replace(/]/g, ']]')}]`
    );
    return true;
  }

  async listDatabases(adminConnection: IDatabaseConnection): Promise<string[]> {
    // database_id > 4 skips master, tempdb, model and msdb.
    const rows = await adminConnection.query<{ name: string }>(
      `SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name`
    );
    return rows.map((row) => row.name);
  }

  async listTables(
    connection: IDatabaseConnection,
    opts: ListTablesOptions = {}
  ): Promise<string[]> {
    // MssqlConnection rewrites ? to @pN, so positional params are fine here.
    const rows = await connection.query<{ table_name: string }>(
      `SELECT TABLE_NAME AS table_name FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME`,
      [opts.schema ?? 'dbo']
    );
    return rows.map((row) => row.table_name);
  }

  quoteIdentifier(name: string): string {
    return `[${name.replace(/]/g, ']]')}]`;
  }

}
