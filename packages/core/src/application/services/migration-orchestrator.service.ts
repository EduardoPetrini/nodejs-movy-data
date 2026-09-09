import { DatabaseAdapterRegistry } from '../../infrastructure/database/registry.js';
import { ConnectionConfig } from '../../domain/types/connection.types.js';
import { ILogger } from '../../domain/ports/logger.port.js';
import { MigrationRunContext } from '../../domain/ports/event-sink.port.js';
import {
  MigrationStepId,
  MIGRATION_STEP_ORDER,
  SchemaDiffSummary,
  StepDetail,
} from '../../domain/types/events.types.js';
import { MigrationCancelledError, ConnectionError } from '../../domain/errors/migration.errors.js';
import { classifyConnectionError } from '../../domain/errors/connection-failure.js';
import { CreateDatabaseUseCase } from '../use-cases/create-database.use-case.js';
import { CompareSchemasUseCase } from '../use-cases/compare-schemas.use-case.js';
import { SyncSchemaUseCase } from '../use-cases/sync-schema.use-case.js';
import { MigrateDataUseCase } from '../use-cases/migrate-data.use-case.js';
import { MigrationResult, SchemaDiff } from '../../domain/types/migration.types.js';
import { retryWithBackoff } from '../../shared/utils.js';

const MAX_CONNECT_RETRIES = 3;
const CONNECT_BASE_DELAY_MS = 1000;

export class MigrationOrchestrator {
  constructor(
    private readonly registry: DatabaseAdapterRegistry,
    private readonly logger: ILogger
  ) {}

  /**
   * `ctx` is optional so the CLI and every existing test keep working unchanged.
   * When supplied, the eight numbered steps below plus connection validation
   * are reported as typed step events, and cancellation is checked between them.
   */
  async run(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    ctx?: MigrationRunContext
  ): Promise<MigrationResult> {
    const sourceAdapters = this.registry.get(sourceConfig.type);
    const destAdapters = this.registry.get(destConfig.type);
    const translator = this.registry.getTranslator(sourceConfig.type, destConfig.type);

    const sourceConnection = sourceAdapters.createConnection(sourceConfig);
    const destConnection = destAdapters.createConnection(destConfig);

    // Admin connection targets the system DB (e.g. 'postgres' for PG, 'mysql' for MySQL)
    const adminConfig: ConnectionConfig = { ...destConfig, database: destAdapters.adminDatabase };
    const adminConnection = destAdapters.createConnection(adminConfig);

    const startedAt = Date.now();
    // Run-local, never instance state: an orchestrator may serve several runs.
    let triggersDisabled = false;
    let disabledTables: string[] = [];
    ctx?.emit({
      type: 'run_started',
      mode: 'full',
      source: { engine: sourceConfig.type, database: sourceConfig.database },
      target: { engine: destConfig.type, database: destConfig.database },
    });

    try {
      await this.step(ctx, 'validate_connections', async () => {
        this.logger.info('Validating connections...');
        await this.connectOrExplain('Source', () => sourceConnection.connect());
        await this.connectOrExplain('Admin', () => adminConnection.connect());
      });

      // Step 1: Create database if needed, then connect to it
      await this.step(
        ctx,
        'create_database',
        async () => {
          const createDb = new CreateDatabaseUseCase(destAdapters, this.logger);
          const created = await createDb.execute(adminConnection, destConfig.database);

          await this.connectOrExplain('Destination', () => destConnection.connect());
          return created;
        },
        (created): StepDetail => ({ kind: 'create_database', database: destConfig.database, created })
      );

      // Step 2: Inspect and diff schemas
      const inspector = sourceAdapters.createSchemaInspector();
      const destInspector = destAdapters.createSchemaInspector();
      const synchronizer = destAdapters.createSchemaSynchronizer();
      const { sourceSchema, diff } = await this.step(
        ctx,
        'inspect_and_diff',
        () => {
          const compareSchemas = new CompareSchemasUseCase(inspector, destInspector, synchronizer, this.logger);
          return compareSchemas.execute(sourceConnection, destConnection);
        },
        (result): StepDetail => ({
          kind: 'inspect_and_diff',
          sourceTables: result.sourceSchema.tables.length,
          sourceSequences: result.sourceSchema.sequences.length,
          sourceEnums: result.sourceSchema.enums.length,
          diff: summariseDiff(result.diff),
        })
      );

      // Step 3: Sync schema (without indexes)
      await this.step(ctx, 'sync_schema', async () => {
        const syncSchema = new SyncSchemaUseCase(synchronizer, translator, sourceConfig.type, destConfig.type, this.logger);
        await syncSchema.execute(destConnection, diff);
      });

      // Step 4: Disable triggers
      const tableNames = sourceSchema.tables.map((t) => t.name);
      triggersDisabled = true;
      disabledTables = tableNames;
      await this.step(
        ctx,
        'disable_triggers',
        () => synchronizer.disableTriggers(destConnection, tableNames),
        (): StepDetail => ({ kind: 'triggers', tables: tableNames.length })
      );

      // Step 5: Migrate data using the appropriate migrator for the source<->dest pair
      const result = await this.step(
        ctx,
        'migrate_data',
        async () => {
          const rowEstimates = await inspector.getTableRowEstimates(sourceConnection);
          const dataMigrator = this.registry.getDataMigrator(sourceConfig.type, destConfig.type);
          const migrateData = new MigrateDataUseCase(dataMigrator, this.logger);
          return migrateData.execute(sourceConfig, destConfig, sourceSchema.tables, rowEstimates, ctx);
        },
        (migrationResult): StepDetail => ({
          kind: 'migrate_data',
          tables: migrationResult.tables.length,
          rowsCopied: migrationResult.tables.reduce((sum, t) => sum + t.rowsCopied, 0),
          failed: migrationResult.tables.filter((t) => !t.success).length,
        })
      );

      // Step 6: Re-enable triggers
      await this.step(
        ctx,
        'enable_triggers',
        async () => {
          await synchronizer.enableTriggers(destConnection, tableNames);
          triggersDisabled = false;
        },
        (): StepDetail => ({ kind: 'triggers', tables: tableNames.length })
      );

      // Step 7: Create indexes
      await this.step(
        ctx,
        'create_indexes',
        () => synchronizer.createIndexes(destConnection, diff),
        (): StepDetail => ({ kind: 'create_indexes', indexes: diff.indexesToCreate.length })
      );

      // Step 8: Reset sequences / per-table AUTO_INCREMENT counters
      await this.step(
        ctx,
        'reset_sequences',
        () =>
          synchronizer.resetSequences(
            sourceConnection,
            destConnection,
            sourceSchema.sequences,
            sourceSchema.tables
          ),
        (): StepDetail => ({ kind: 'reset_sequences', sequences: sourceSchema.sequences.length })
      );

      ctx?.emit({
        type: 'run_finished',
        status: result.success ? 'succeeded' : 'failed',
        durationMs: Date.now() - startedAt,
        result,
      });

      return result;
    } catch (err) {
      const cancelled = err instanceof MigrationCancelledError;
      if (cancelled && triggersDisabled) {
        // PG's DISABLE TRIGGER and MSSQL's NOCHECK CONSTRAINT are persistent
        // schema state, so cancelling between steps 4 and 6 would leave the
        // destination permanently unguarded. MySQL's session flag dies with the
        // connection and needs nothing. Best effort: never mask the real error.
        try {
          await destAdapters.createSchemaSynchronizer().enableTriggers(destConnection, disabledTables);
          this.logger.info('Re-enabled destination triggers after cancellation.');
        } catch (compensationErr) {
          const message =
            compensationErr instanceof Error ? compensationErr.message : String(compensationErr);
          this.logger.warn(`Could not re-enable destination triggers after cancellation: ${message}`);
          ctx?.emit({ type: 'log', level: 'warn', message: `Could not re-enable destination triggers after cancellation: ${message}` });
        }
      }
      ctx?.emit({
        type: 'run_finished',
        status: cancelled ? 'cancelled' : 'failed',
        durationMs: Date.now() - startedAt,
        error: toSerialisedError(err),
      });
      throw err;
    } finally {
      await Promise.allSettled([
        sourceConnection.end(),
        destConnection.end(),
        adminConnection.end(),
      ]);
    }
  }

  /**
   * Connects with the standard retry, and on final failure replaces the
   * driver's message with one that says what kind of failure it was.
   *
   * The driver's own text is kept after the summary rather than discarded: it
   * is what an operator pastes into a search engine, and the classifier returns
   * `unknown` often enough that dropping it would make some failures
   * undiagnosable. The summary goes FIRST because that is the half a
   * non-specialist can act on.
   */
  private async connectOrExplain(role: string, connect: () => Promise<void>): Promise<void> {
    try {
      await retryWithBackoff(
        connect,
        MAX_CONNECT_RETRIES,
        CONNECT_BASE_DELAY_MS,
        (attempt, err, delayMs) =>
          this.logger.warn(
            `${role} connection attempt ${attempt} failed: ${err.message}. Retrying in ${delayMs}ms...`
          )
      );
    } catch (err) {
      const { kind, summary } = classifyConnectionError(err);
      const detail = err instanceof Error ? err.message : String(err);
      const failure = new ConnectionError(
        `${role} connection failed (${kind}). ${summary} The database said: ${detail}`
      );
      // The original is kept reachable for anything that wants the driver's own
      // shape; only the message a human reads has been rewritten.
      (failure as Error & { cause?: unknown }).cause = err;
      throw failure;
    }
  }

  /**
   * Times one step, reports it, and checks for cancellation before starting.
   *
   * Cancellation is only ever observed at these boundaries and between tables:
   * an in-flight COPY or CREATE INDEX cannot be interrupted from Node without
   * per-driver support (pg_cancel_backend, KILL QUERY, request.cancel).
   */
  private async step<T>(
    ctx: MigrationRunContext | undefined,
    stepId: MigrationStepId,
    fn: () => Promise<T>,
    detail?: (result: T) => StepDetail
  ): Promise<T> {
    if (ctx?.signal?.aborted) {
      throw new MigrationCancelledError(`Migration cancelled before step "${stepId}"`);
    }

    const ordinal = MIGRATION_STEP_ORDER.indexOf(stepId);
    ctx?.emit({ type: 'step_started', stepId, ordinal });
    const startedAt = Date.now();

    try {
      const result = await fn();
      ctx?.emit({
        type: 'step_finished',
        stepId,
        status: 'ok',
        durationMs: Date.now() - startedAt,
        detail: detail?.(result),
      });
      return result;
    } catch (err) {
      ctx?.emit({
        type: 'step_finished',
        stepId,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: toSerialisedError(err),
      });
      throw err;
    }
  }

}

function summariseDiff(diff: SchemaDiff): SchemaDiffSummary {
  return {
    tablesToCreate: diff.tablesToCreate.length,
    tablesToDrop: diff.tablesToDrop.length,
    columnsToAdd: diff.columnsToAdd.length,
    columnsToDrop: diff.columnsToDrop.length,
    columnsToAlter: diff.columnsToAlter.length,
    constraintsToAdd: diff.constraintsToAdd.length,
    constraintsToDrop: diff.constraintsToDrop.length,
    indexesToCreate: diff.indexesToCreate.length,
    indexesToDrop: diff.indexesToDrop.length,
    sequencesToCreate: diff.sequencesToCreate.length,
    enumsToCreate: diff.enumsToCreate.length,
  };
}

function toSerialisedError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'Error', message: String(err) };
}
