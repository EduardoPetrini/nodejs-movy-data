/**
 * Public surface of @movy/core.
 *
 * Delivery surfaces (apps/cli, apps/runner, apps/web) import from here and never
 * reach into deep paths, so the internal layout stays free to move.
 *
 * Includes the event contract, the registry composition root and the Pair
 * descriptors a UI needs to render capability without hardcoding it.
 */

// ---- Domain: types ----
export { DatabaseType } from './domain/types/connection.types';
export type { ConnectionConfig, SslConfig } from './domain/types/connection.types';
export type {
  DatabaseSchema, TableSchema, ColumnSchema, ConstraintSchema,
  IndexSchema, SequenceSchema, EnumSchema,
} from './domain/types/schema.types';
export type {
  MigrationResult, TableMigrationResult, TableMigrationPlan,
  SchemaDiff, ColumnDiff,
} from './domain/types/migration.types';
export type { WorkerMessage, WorkerMessageType } from './domain/types/worker.types';

// ---- Domain: the event contract ----
export { MIGRATION_STEP_ORDER } from './domain/types/events.types';
export type {
  MigrationEvent, MigrationEventInput, MigrationEventType, MigrationStepId,
  StepStatus, StepDetail, SchemaDiffSummary, SafeEndpoint, SerialisedError,
  LogLevel, RunTerminalStatus,
} from './domain/types/events.types';
export type {
  MigrationEventSink, SequencedEventSink, MigrationRunContext,
} from './domain/ports/event-sink.port';
export { composeSink, createSeqSink, createThrottledSink, createSafeSink } from './application/events';

// ---- Domain: ports ----
export type { ILogger } from './domain/ports/logger.port';
export type { IDatabaseConnection, IDbClient } from './domain/ports/database.port';
export type { ISchemaInspector } from './domain/ports/schema-inspector.port';
export type { ISchemaSynchronizer } from './domain/ports/schema-synchronizer.port';
export type { ISchemaTranslator } from './domain/ports/schema-translator.port';
export type { IDataMigrator, MigrationProgressCallback } from './domain/ports/data-migrator.port';
export type { IQueryAnalyzer, QueryColumn } from './domain/ports/query-analyzer.port';

// ---- Domain: errors ----
export * from './domain/errors/migration.errors';

// ---- Application ----
export { MigrationOrchestrator } from './application/services/migration-orchestrator.service';
export { TableMigrationPlanner } from './application/services/table-migration-planner.service';
export { CreateDatabaseUseCase } from './application/use-cases/create-database.use-case';
export { CompareSchemasUseCase } from './application/use-cases/compare-schemas.use-case';
export { SyncSchemaUseCase } from './application/use-cases/sync-schema.use-case';
export { MigrateDataUseCase } from './application/use-cases/migrate-data.use-case';
export { MigrateQueryUseCase } from './application/use-cases/migrate-query.use-case';
export { ValidateCountsUseCase } from './application/use-cases/validate-counts.use-case';
export type {
  ValidateCountsResult, TableCountResult, ValidateCountsTarget,
} from './application/use-cases/validate-counts.use-case';

// ---- Composition root ----
export { buildRegistry } from './composition/build-registry';
export { listSupportedPairs } from './composition/pairs';
export type { PairDescriptor } from './composition/pairs';

// ---- Infrastructure: registry and Adapter Sets ----
export { DatabaseAdapterRegistry, PassthroughSchemaTranslator } from './infrastructure/database/registry';
export type { DatabaseAdapterSet, ListTablesOptions } from './infrastructure/database/registry';
export { PgAdapterSet } from './infrastructure/database/pg/pg-adapter-set';
export { MysqlAdapterSet } from './infrastructure/database/mysql/mysql-adapter-set';
export { MssqlAdapterSet } from './infrastructure/database/mssql/mssql-adapter-set';

// ---- Infrastructure: query analyzers ----
export { PgQueryAnalyzer } from './infrastructure/database/pg/pg-query-analyzer.adapter';

// ---- Infrastructure: cross-engine translators (one per directional Pair) ----
export { MysqlToPostgresTranslator } from './infrastructure/database/mysql/mysql-to-postgres-translator.adapter';
export { MysqlToMssqlTranslator } from './infrastructure/database/mysql/mysql-to-mssql-translator.adapter';
export { PostgresToMysqlTranslator } from './infrastructure/database/pg/postgres-to-mysql-translator.adapter';
export { PostgresToMssqlTranslator } from './infrastructure/database/pg/postgres-to-mssql-translator.adapter';
export { MssqlToPostgresTranslator } from './infrastructure/database/mssql/mssql-to-postgres-translator.adapter';
export { MssqlToMysqlTranslator } from './infrastructure/database/mssql/mssql-to-mysql-translator.adapter';

// ---- Infrastructure: data migrators ----
export { CrossDbDataMigrator } from './infrastructure/migration/cross-db-data-migrator';
export { MssqlCrossDbDataMigrator } from './infrastructure/migration/mssql-cross-db-data-migrator';

// ---- Infrastructure: logging ----
export { ConsoleLogger } from './infrastructure/logging/console-logger.adapter';
export { FileLogger } from './infrastructure/logging/file-logger.adapter';
export { TeeLogger } from './infrastructure/logging/tee-logger.adapter';
export { SinkLogger } from './infrastructure/logging/sink-logger.adapter';

// ---- Shared ----
export { formatDuration, loadEnvFile, retryWithBackoff, resolveWorkerPath } from './shared/utils';
export { buildLogFilePath, resolveLogDir } from './shared/log-path';
