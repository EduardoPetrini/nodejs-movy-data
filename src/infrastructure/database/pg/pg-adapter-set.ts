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

  createSchemaTranslator(): ISchemaTranslator {
    return new PgSchemaTranslator();
  }
}
