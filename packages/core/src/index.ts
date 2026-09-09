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
export { DatabaseType } from './domain/types/connection.types.js';
export type { ConnectionConfig, SslConfig } from './domain/types/connection.types.js';
export type {
  DatabaseSchema, TableSchema, ColumnSchema, ConstraintSchema,
  IndexSchema, SequenceSchema, EnumSchema,
} from './domain/types/schema.types.js';
export type {
  MigrationResult, TableMigrationResult, TableMigrationPlan,
  SchemaDiff, ColumnDiff,
} from './domain/types/migration.types.js';
export type { WorkerMessage, WorkerMessageType } from './domain/types/worker.types.js';

// ---- Domain: the event contract ----
export { MIGRATION_STEP_ORDER } from './domain/types/events.types.js';
export type {
  MigrationEvent, MigrationEventInput, MigrationEventType, MigrationStepId,
  StepStatus, StepDetail, SchemaDiffSummary, SafeEndpoint, SerialisedError,
  LogLevel, RunTerminalStatus,
} from './domain/types/events.types.js';
export type {
  MigrationEventSink, SequencedEventSink, MigrationRunContext,
} from './domain/ports/event-sink.port.js';
export {
  composeSink, createSeqSink, createThrottledSink, createSafeSink,
  createRedactingSink, redactValue, redactString, buildNeedles,
  REDACTED, MIN_REDACTABLE_SECRET_LENGTH,
} from './application/events/index.js';

// ---- Domain: ports ----
export type { ILogger } from './domain/ports/logger.port.js';
export type { IDatabaseConnection, IDbClient } from './domain/ports/database.port.js';
export type { ISchemaInspector } from './domain/ports/schema-inspector.port.js';
export type { ISchemaSynchronizer } from './domain/ports/schema-synchronizer.port.js';
export type { ISchemaTranslator } from './domain/ports/schema-translator.port.js';
export type { IDataMigrator, MigrationProgressCallback } from './domain/ports/data-migrator.port.js';
export type { IQueryAnalyzer, QueryColumn } from './domain/ports/query-analyzer.port.js';

// ---- Domain: errors ----
export * from './domain/errors/migration.errors.js';
export { classifyConnectionError, summaryForKind } from './domain/errors/connection-failure.js';
export type { ConnectionFailure, ConnectionFailureKind } from './domain/errors/connection-failure.js';

// ---- Application ----
export { MigrationOrchestrator } from './application/services/migration-orchestrator.service.js';
export { TableMigrationPlanner } from './application/services/table-migration-planner.service.js';
export { CreateDatabaseUseCase } from './application/use-cases/create-database.use-case.js';
export { CompareSchemasUseCase } from './application/use-cases/compare-schemas.use-case.js';
export { SyncSchemaUseCase } from './application/use-cases/sync-schema.use-case.js';
export { MigrateDataUseCase } from './application/use-cases/migrate-data.use-case.js';
export { MigrateQueryUseCase } from './application/use-cases/migrate-query.use-case.js';
export { ValidateCountsUseCase } from './application/use-cases/validate-counts.use-case.js';
export type {
  ValidateCountsResult, TableCountResult, ValidateCountsTarget,
} from './application/use-cases/validate-counts.use-case.js';

// ---- Composition root ----
export { buildRegistry } from './composition/build-registry.js';
export { listSupportedPairs } from './composition/pairs.js';
export type { PairDescriptor } from './composition/pairs.js';

// ---- Infrastructure: registry and Adapter Sets ----
export { DatabaseAdapterRegistry, PassthroughSchemaTranslator } from './infrastructure/database/registry.js';
export type { DatabaseAdapterSet, ListTablesOptions } from './infrastructure/database/registry.js';
export { PgAdapterSet } from './infrastructure/database/pg/pg-adapter-set.js';
export { MysqlAdapterSet } from './infrastructure/database/mysql/mysql-adapter-set.js';
export { MssqlAdapterSet } from './infrastructure/database/mssql/mssql-adapter-set.js';

// ---- Infrastructure: query analyzers ----
export { PgQueryAnalyzer } from './infrastructure/database/pg/pg-query-analyzer.adapter.js';

// ---- Infrastructure: cross-engine translators (one per directional Pair) ----
export { MysqlToPostgresTranslator } from './infrastructure/database/mysql/mysql-to-postgres-translator.adapter.js';
export { MysqlToMssqlTranslator } from './infrastructure/database/mysql/mysql-to-mssql-translator.adapter.js';
export { PostgresToMysqlTranslator } from './infrastructure/database/pg/postgres-to-mysql-translator.adapter.js';
export { PostgresToMssqlTranslator } from './infrastructure/database/pg/postgres-to-mssql-translator.adapter.js';
export { MssqlToPostgresTranslator } from './infrastructure/database/mssql/mssql-to-postgres-translator.adapter.js';
export { MssqlToMysqlTranslator } from './infrastructure/database/mssql/mssql-to-mysql-translator.adapter.js';

// ---- Infrastructure: data migrators ----
export { CrossDbDataMigrator } from './infrastructure/migration/cross-db-data-migrator.js';
export { MssqlCrossDbDataMigrator } from './infrastructure/migration/mssql-cross-db-data-migrator.js';

// ---- Infrastructure: logging ----
export { ConsoleLogger } from './infrastructure/logging/console-logger.adapter.js';
export { FileLogger } from './infrastructure/logging/file-logger.adapter.js';
export { TeeLogger } from './infrastructure/logging/tee-logger.adapter.js';
export { SinkLogger } from './infrastructure/logging/sink-logger.adapter.js';

// ---- Shared ----
export { formatDuration, loadEnvFile, retryWithBackoff, resolveWorkerPath } from './shared/utils.js';
export { buildLogFilePath, resolveLogDir } from './shared/log-path.js';
