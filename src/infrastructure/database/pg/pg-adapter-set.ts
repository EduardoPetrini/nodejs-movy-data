import { DatabaseAdapterSet } from '../registry';
import { ConnectionConfig } from '../../../domain/types/connection.types';
import { IDatabaseConnection } from '../../../domain/ports/database.port';
import { ISchemaInspector } from '../../../domain/ports/schema-inspector.port';
import { ISchemaSynchronizer } from '../../../domain/ports/schema-synchronizer.port';
import { IDataMigrator } from '../../../domain/ports/data-migrator.port';
import { ISchemaTranslator } from '../../../domain/ports/schema-translator.port';
import { PgConnection } from './pg-connection.adapter';
import { PgSchemaInspector } from './pg-schema-inspector.adapter';
import { PgSchemaSynchronizer } from './pg-schema-synchronizer.adapter';
import { PgSchemaTranslator } from './pg-schema-translator.adapter';
import { PgDataMigrator } from '../../migration/pg-data-migrator.adapter';

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
}
