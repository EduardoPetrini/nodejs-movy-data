import { DatabaseAdapterRegistry } from '../../infrastructure/database/registry';
import { ConnectionConfig } from '../../domain/types/connection.types';
import { ILogger } from '../../domain/ports/logger.port';
import { CreateDatabaseUseCase } from '../use-cases/create-database.use-case';
import { CompareSchemasUseCase } from '../use-cases/compare-schemas.use-case';
import { SyncSchemaUseCase } from '../use-cases/sync-schema.use-case';
import { MigrateDataUseCase } from '../use-cases/migrate-data.use-case';
import { MigrationResult } from '../../domain/types/migration.types';
import { retryWithBackoff } from '../../shared/utils';

const MAX_CONNECT_RETRIES = 3;
const CONNECT_BASE_DELAY_MS = 1000;

export class MigrationOrchestrator {
  constructor(
    private readonly registry: DatabaseAdapterRegistry,
    private readonly logger: ILogger
  ) {}

  async run(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig
  ): Promise<MigrationResult> {
    const sourceAdapters = this.registry.get(sourceConfig.type);
    const destAdapters = this.registry.get(destConfig.type);
    const translator = this.registry.getTranslator(sourceConfig.type, destConfig.type);

    const sourceConnection = sourceAdapters.createConnection(sourceConfig);
    const destConnection = destAdapters.createConnection(destConfig);

    // Admin connection targets the system DB (e.g. 'postgres' for PG, 'mysql' for MySQL)
    const adminConfig: ConnectionConfig = { ...destConfig, database: destAdapters.adminDatabase };
    const adminConnection = destAdapters.createConnection(adminConfig);

    try {
      this.logger.info('Validating connections...');
      await retryWithBackoff(
        () => sourceConnection.connect(),
        MAX_CONNECT_RETRIES,
        CONNECT_BASE_DELAY_MS,
        (attempt, err, delayMs) =>
          this.logger.warn(`Source connection attempt ${attempt} failed: ${err.message}. Retrying in ${delayMs}ms...`)
      );
      await retryWithBackoff(
        () => adminConnection.connect(),
        MAX_CONNECT_RETRIES,
        CONNECT_BASE_DELAY_MS,
        (attempt, err, delayMs) =>
          this.logger.warn(`Admin connection attempt ${attempt} failed: ${err.message}. Retrying in ${delayMs}ms...`)
      );

      // Step 1: Create database if needed
      const createDb = new CreateDatabaseUseCase(destAdapters, this.logger);
      await createDb.execute(adminConnection, destConfig.database);

      // Now connect to the actual dest database
      await retryWithBackoff(
        () => destConnection.connect(),
        MAX_CONNECT_RETRIES,
        CONNECT_BASE_DELAY_MS,
        (attempt, err, delayMs) =>
          this.logger.warn(`Destination connection attempt ${attempt} failed: ${err.message}. Retrying in ${delayMs}ms...`)
      );

      // Step 2: Inspect and diff schemas
      const inspector = sourceAdapters.createSchemaInspector();
      const destInspector = destAdapters.createSchemaInspector();
      const synchronizer = destAdapters.createSchemaSynchronizer();
      const compareSchemas = new CompareSchemasUseCase(inspector, destInspector, synchronizer, this.logger);
      const { sourceSchema, diff } = await compareSchemas.execute(sourceConnection, destConnection);

      // Step 3: Sync schema (without indexes)
      const syncSchema = new SyncSchemaUseCase(synchronizer, translator, sourceConfig.type, destConfig.type, this.logger);
      await syncSchema.execute(destConnection, diff);

      // Step 4: Disable triggers
      const tableNames = sourceSchema.tables.map((t) => t.name);
      await synchronizer.disableTriggers(destConnection, tableNames);

      // Step 5: Migrate data using the appropriate migrator for the source↔dest pair
      const rowEstimates = await inspector.getTableRowEstimates(sourceConnection);
      const dataMigrator = this.registry.getDataMigrator(sourceConfig.type, destConfig.type);
      const migrateData = new MigrateDataUseCase(dataMigrator, this.logger);
      const result = await migrateData.execute(sourceConfig, destConfig, tableNames, rowEstimates);

      // Step 6: Re-enable triggers
      await synchronizer.enableTriggers(destConnection, tableNames);

      // Step 7: Create indexes
      await synchronizer.createIndexes(destConnection, diff);

      // Step 8: Reset sequences
      await synchronizer.resetSequences(sourceConnection, destConnection, sourceSchema.sequences);

      return result;
    } finally {
      await Promise.allSettled([
        sourceConnection.end(),
        destConnection.end(),
        adminConnection.end(),
      ]);
    }
  }
}
