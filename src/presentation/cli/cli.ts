import * as path from 'path';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import {
  promptConnectionConfig,
  promptMigrationMode,
  promptQueryMigration,
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
import { UnsupportedDatabaseError } from '../../domain/errors/migration.errors';
import { retryWithBackoff } from '../../shared/utils';

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

export async function runCli(): Promise<void> {
  const consoleLogger = new ConsoleLogger('movy');
  const rl = readline.createInterface({ input, output });

  console.log('\n=== Movy Data Migration ===\n');

  let fileLogger: FileLogger | null = null;

  try {
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

    const mode = await promptMigrationMode(rl);

    let success = false;

    if (mode === 'query') {
      const { query, targetTableName } = await promptQueryMigration(rl);
      rl.close();

      // For query mode, only the destination DB type needs a synchronizer.
      // We allow source and dest to differ in future but currently both must be Postgres.
      if (sourceConfig.type !== DatabaseType.POSTGRES) {
        logger.error('Custom query migration currently supports PostgreSQL source databases only.');
        process.exit(1);
      }

      const sourceAdapters = registry.get(sourceConfig.type);
      const destAdapters = registry.get(destConfig.type);

      const sourceConnection = sourceAdapters.createConnection(sourceConfig);
      const destConnection = destAdapters.createConnection(destConfig);

      // Create dest DB if needed via admin connection
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
      rl.close();
      const orchestrator = new MigrationOrchestrator(registry, logger);
      const result = await orchestrator.run(sourceConfig, destConfig);
      success = result.success;
    }

    if (success) {
      await new Promise<void>((resolve) => {
        process.stdout.write('\nMigration completed successfully. Press Enter to exit...');
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        process.stdin.once('data', () => {
          process.stdin.pause();
          resolve();
        });
      });
    }

    process.exit(success ? 0 : 1);
  } catch (err) {
    rl.close();
    const message = err instanceof Error ? err.message : String(err);
    consoleLogger.error(`Migration failed: ${message}`);
    process.exit(1);
  } finally {
    if (fileLogger) {
      await fileLogger.close();
    }
  }
}
