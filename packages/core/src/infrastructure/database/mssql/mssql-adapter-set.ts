import { DatabaseAdapterSet } from '../registry';
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
}
