import * as path from 'path';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import {
  promptConnectionConfig,
  promptMigrationMode,
  promptQueryMigration,
  promptAppMode,
} from './prompt';
import { DatabaseAdapterRegistry } from '../../infrastructure/database/registry';
import { DatabaseType } from '../../domain/types/connection.types';
import { ConsoleLogger } from '../../infrastructure/logging/console-logger.adapter';
import { FileLogger } from '../../infrastructure/logging/file-logger.adapter';
import { TeeLogger } from '../../infrastructure/logging/tee-logger.adapter';
import { PgAdapterSet } from '../../infrastructure/database/pg/pg-adapter-set';
import { PgQueryAnalyzer } from '../../infrastructure/database/pg/pg-query-analyzer.adapter';
import { MigrationOrchestrator } from '../../application/services/migration-orchestrator.service';
import { MigrateQueryUseCase } from '../../application/use-cases/migrate-query.use-case';
import { ValidateCountsUseCase } from '../../application/use-cases/validate-counts.use-case';
import { UnsupportedDatabaseError } from '../../domain/errors/migration.errors';
import { retryWithBackoff } from '../../shared/utils';
import { ConnectionConfig } from '../../domain/types/connection.types';
import { ILogger } from '../../domain/ports/logger.port';

const MAX_CONNECT_RETRIES = 3;
const CONNECT_BASE_DELAY_MS = 1000;

function buildRegistry(): DatabaseAdapterRegistry {
  const registry = new DatabaseAdapterRegistry();
  registry.register(DatabaseType.POSTGRES, new PgAdapterSet());
  return registry;
}

function buildLogFilePath(sourceDb: string, destDb: string): string {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);
  const timePart = now.toISOString().slice(11, 19).replace(/:/g, '-');
  const safeSrc = sourceDb.replace(/[^a-z0-9_-]/gi, '_');
  const safeDst = destDb.replace(/[^a-z0-9_-]/gi, '_');
  const filename = `movy_${datePart}_${timePart}_${safeSrc}_to_${safeDst}.log`;
  return path.join('logs', filename);
}

async function runValidation(
  rl: readline.Interface,
  sourceConfig: ConnectionConfig,
  destConfig: ConnectionConfig,
  registry: DatabaseAdapterRegistry,
  logger: ILogger
): Promise<void> {
  const sourceAdapters = registry.get(sourceConfig.type);
  const destAdapters = registry.get(destConfig.type);

  const sourceConnection = sourceAdapters.createConnection(sourceConfig);
  const destConnection = destAdapters.createConnection(destConfig);

  try {
    logger.info('Connecting for validation...');
    await retryWithBackoff(
      () => sourceConnection.connect(),
      MAX_CONNECT_RETRIES,
      CONNECT_BASE_DELAY_MS,
      (attempt, err, delayMs) =>
        logger.warn(`Source connection attempt ${attempt} failed: ${err.message}. Retrying in ${delayMs}ms...`)
    );
    await retryWithBackoff(
      () => destConnection.connect(),
      MAX_CONNECT_RETRIES,
      CONNECT_BASE_DELAY_MS,
      (attempt, err, delayMs) =>
        logger.warn(`Destination connection attempt ${attempt} failed: ${err.message}. Retrying in ${delayMs}ms...`)
    );

    const validateCounts = new ValidateCountsUseCase(logger);
    await validateCounts.execute(sourceConnection, destConnection);
  } finally {
    await Promise.allSettled([sourceConnection.end(), destConnection.end()]);
  }
}

export async function runCli(): Promise<void> {
  const consoleLogger = new ConsoleLogger('movy');
  const rl = readline.createInterface({ input, output });

  console.log('\n=== Movy Data Migration ===\n');

  let fileLogger: FileLogger | null = null;

  try {
    const appMode = await promptAppMode(rl);

    const sourceConfig = await promptConnectionConfig(rl, 'Source');
    const destConfig = await promptConnectionConfig(rl, 'Destination', {
      database: sourceConfig.database,
    });

    // Set up file logging now that we know the DB names
    const logFilePath = buildLogFilePath(sourceConfig.database, destConfig.database);
    fileLogger = new FileLogger(logFilePath);
    const logger = new TeeLogger([consoleLogger, fileLogger]);
    logger.info(`Log file: ${path.resolve(logFilePath)}`);

    const registry = buildRegistry();

    try {
      registry.get(sourceConfig.type);
      registry.get(destConfig.type);
    } catch (err) {
      if (err instanceof UnsupportedDatabaseError) {
        logger.error(err.message);
        process.exit(1);
      }
      throw err;
    }

    if (appMode === 'validate') {
      await runValidation(rl, sourceConfig, destConfig, registry, logger);
      await rl.question('\nValidation complete. Press Enter to exit...');
      rl.close();
      process.exit(0);
    }

    // --- Migration mode ---
    const mode = await promptMigrationMode(rl);

    let success = false;

    if (mode === 'query') {
      const { query, targetTableName } = await promptQueryMigration(rl);

      if (sourceConfig.type !== DatabaseType.POSTGRES) {
        logger.error('Custom query migration currently supports PostgreSQL source databases only.');
        process.exit(1);
      }

      const sourceAdapters = registry.get(sourceConfig.type);
      const destAdapters = registry.get(destConfig.type);

      const sourceConnection = sourceAdapters.createConnection(sourceConfig);
      const destConnection = destAdapters.createConnection(destConfig);

      const adminConfig = { ...destConfig, database: 'postgres' };
      const adminConnection = destAdapters.createConnection(adminConfig);

      try {
        logger.info('Validating connections...');
        await retryWithBackoff(
          () => sourceConnection.connect(),
          MAX_CONNECT_RETRIES,
          CONNECT_BASE_DELAY_MS,
          (attempt, err, delayMs) =>
            logger.warn(`Source connection attempt ${attempt} failed: ${err.message}. Retrying in ${delayMs}ms...`)
        );
        await retryWithBackoff(
          () => adminConnection.connect(),
          MAX_CONNECT_RETRIES,
          CONNECT_BASE_DELAY_MS,
          (attempt, err, delayMs) =>
            logger.warn(`Admin connection attempt ${attempt} failed: ${err.message}. Retrying in ${delayMs}ms...`)
        );

        const { CreateDatabaseUseCase } = await import('../../application/use-cases/create-database.use-case');
        const createDb = new CreateDatabaseUseCase(logger);
        await createDb.execute(adminConnection, destConfig.database);

        await retryWithBackoff(
          () => destConnection.connect(),
          MAX_CONNECT_RETRIES,
          CONNECT_BASE_DELAY_MS,
          (attempt, err, delayMs) =>
            logger.warn(`Destination connection attempt ${attempt} failed: ${err.message}. Retrying in ${delayMs}ms...`)
        );

        const analyzer = new PgQueryAnalyzer();
        const synchronizer = destAdapters.createSchemaSynchronizer();
        const migrateQuery = new MigrateQueryUseCase(analyzer, synchronizer, logger);

        const result = await migrateQuery.execute(
          sourceConnection,
          destConnection,
          query,
          targetTableName
        );
        success = result.success;
      } finally {
        await Promise.allSettled([
          sourceConnection.end(),
          destConnection.end(),
          adminConnection.end(),
        ]);
      }
    } else {
      const orchestrator = new MigrationOrchestrator(registry, logger);
      const result = await orchestrator.run(sourceConfig, destConfig);
      success = result.success;
    }

    if (success) {
      logger.info('Migration completed successfully.');

      const runValidate = await rl.question('\nRun row count validation? [Y/n]: ');
      if (!runValidate.trim() || runValidate.trim().toLowerCase() === 'y') {
        await runValidation(rl, sourceConfig, destConfig, registry, logger);
      }
    }

    await rl.question('\nDone. Press Enter to exit...');
    rl.close();
    process.exit(success ? 0 : 1);
  } catch (err) {
    rl.close();
    const message = err instanceof Error ? err.message : String(err);
    consoleLogger.error(`Failed: ${message}`);
    process.exit(1);
  } finally {
    if (fileLogger) {
      await fileLogger.close();
    }
  }
}
