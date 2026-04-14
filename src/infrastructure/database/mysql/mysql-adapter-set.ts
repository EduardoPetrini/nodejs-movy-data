import { DatabaseAdapterSet } from '../registry';
import { ConnectionConfig } from '../../../domain/types/connection.types';
import { IDatabaseConnection } from '../../../domain/ports/database.port';
import { ISchemaInspector } from '../../../domain/ports/schema-inspector.port';
import { ISchemaSynchronizer } from '../../../domain/ports/schema-synchronizer.port';
import { IDataMigrator } from '../../../domain/ports/data-migrator.port';
import { MysqlConnection } from './mysql-connection.adapter';
import { MysqlSchemaInspector } from './mysql-schema-inspector.adapter';
import { MysqlSchemaSynchronizer } from './mysql-schema-synchronizer.adapter';
import { MysqlDataMigrator } from '../../migration/mysql-data-migrator.adapter';

export class MysqlAdapterSet implements DatabaseAdapterSet {
  readonly adminDatabase = 'mysql';

  createConnection(config: ConnectionConfig): IDatabaseConnection {
    return new MysqlConnection(config);
  }

  createSchemaInspector(): ISchemaInspector {
    return new MysqlSchemaInspector();
  }

  createSchemaSynchronizer(): ISchemaSynchronizer {
    return new MysqlSchemaSynchronizer();
  }

  createDataMigrator(): IDataMigrator {
    return new MysqlDataMigrator();
  }

  async ensureDatabase(adminConnection: IDatabaseConnection, dbName: string): Promise<boolean> {
    const rows = await adminConnection.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
      [dbName]
    );
    if ((rows[0]?.count ?? 0) > 0) return false;
    await adminConnection.query(
      `CREATE DATABASE \`${dbName.replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    return true;
  }
}
