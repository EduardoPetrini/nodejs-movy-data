import * as path from 'path';
import { randomUUID } from 'crypto';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import {
  promptAppMode,
  promptConnectionConfig,
  promptExecutionReview,
  promptMigrationMode,
  promptPressEnterToExit,
  promptQueryMigration,
  renderCliWelcome,
} from './prompt';
import { createEventJournal, parseJsonEventsFlag } from './event-journal';
import {
  MigrationOrchestrator,
  CreateDatabaseUseCase,
  MigrateQueryUseCase,
  ValidateCountsUseCase,
  DatabaseAdapterRegistry,
  UnsupportedDatabaseError,
  ConsoleLogger,
  FileLogger,
  TeeLogger,
  SinkLogger,
  PgQueryAnalyzer,
  DatabaseType,
  buildRegistry,
  buildLogFilePath,
  retryWithBackoff,
} from '@movy/core';
import type { ConnectionConfig, ILogger } from '@movy/core';

const MAX_CONNECT_RETRIES = 3;
const CONNECT_BASE_DELAY_MS = 1000;

async function runValidation(
  _rl: readline.Interface,
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
    await validateCounts.execute(
      sourceConnection,
      destConnection,
      { type: sourceConfig.type, database: sourceConfig.database },
      { type: destConfig.type, database: destConfig.database }
    );
  } finally {
    await Promise.allSettled([sourceConnection.end(), destConnection.end()]);
  }
}

export async function runCli(): Promise<void> {
  const consoleLogger = new ConsoleLogger('movy');
  const rl = readline.createInterface({ input, output, historySize: 0 });
  let fileLogger: FileLogger | null = null;

  try {
    renderCliWelcome();

    const registry = buildRegistry();
    const supportedTypes = registry.listTypes();
    const appMode = await promptAppMode(rl);
    const source = await promptConnectionConfig(rl, 'Source', {
      supportedTypes,
      envRole: 'SOURCE',
    });
    const destination = await promptConnectionConfig(rl, 'Destination', {
      supportedTypes,
      defaultDatabase: source.config.database,
      envRole: 'TARGET',
    });

    let migrationMode: 'full' | 'query' | undefined;
    if (appMode === 'migrate') {
      migrationMode = await promptMigrationMode(rl);
    }

    const review = await promptExecutionReview(rl, {
      appMode,
      migrationMode,
      source,
      destination,
    });

    const sourceConfig = source.config;
    const destConfig = destination.config;
    const logFilePath = buildLogFilePath(sourceConfig.database, destConfig.database);
    fileLogger = new FileLogger(logFilePath);
    const logger = new TeeLogger([consoleLogger, fileLogger]);
    logger.info(`Log file: ${path.resolve(logFilePath)}`);

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
      await promptPressEnterToExit(rl, 'Validation complete. Press Enter to exit...');
      rl.close();
      process.exit(0);
    }

    const mode = migrationMode!;
    let success = false;

    if (mode === 'query') {
      const { query, targetTableName } = await promptQueryMigration(rl);

      // MigrateQueryUseCase streams via PostgreSQL COPY and casts BOTH connections
      // to PgConnection, so destination must be PostgreSQL too — not just source.
      if (sourceConfig.type !== DatabaseType.POSTGRES || destConfig.type !== DatabaseType.POSTGRES) {
        logger.error(
          'Custom query migration currently supports PostgreSQL sources and destinations only. ' +
            `Got source=${sourceConfig.type}, destination=${destConfig.type}.`
        );
        process.exit(1);
      }

      const sourceAdapters = registry.get(sourceConfig.type);
      const destAdapters = registry.get(destConfig.type);
      const sourceConnection = sourceAdapters.createConnection(sourceConfig);
      const destConnection = destAdapters.createConnection(destConfig);
      const adminConfig = { ...destConfig, database: destAdapters.adminDatabase };
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

        const createDb = new CreateDatabaseUseCase(destAdapters, logger);
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
      const journalPath = parseJsonEventsFlag(process.argv.slice(2), logFilePath);
      const journal = journalPath ? createEventJournal(journalPath, randomUUID()) : null;

      // SinkLogger puts every existing logger.* line onto the event stream too,
      // so the journal carries narration as well as structured state.
      const runLogger = journal
        ? new TeeLogger([logger, new SinkLogger(journal.context.emit)])
        : logger;

      if (journal) logger.info(`Event journal: ${path.resolve(journal.path)}`);

      try {
        const orchestrator = new MigrationOrchestrator(registry, runLogger);
        const result = await orchestrator.run(sourceConfig, destConfig, journal?.context);
        success = result.success;
      } finally {
        await journal?.close();
      }
    }

    if (success) {
      logger.info('Migration completed successfully.');
      if (review.runValidationAfterMigration) {
        await runValidation(rl, sourceConfig, destConfig, registry, logger);
      }
    }

    await promptPressEnterToExit(rl, 'Done. Press Enter to exit...');
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
