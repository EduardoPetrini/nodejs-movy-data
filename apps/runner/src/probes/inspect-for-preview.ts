import {
  CompareSchemasUseCase, ConsoleLogger, TableMigrationPlanner, buildRegistry,
  type ConnectionConfig, type ConnectionFailureKind, type DatabaseAdapterSet, type DatabaseSchema,
  type IDatabaseConnection, type SchemaDiff, type TableMigrationPlan,
} from '@movy/core';
import { describeConnectionFailure } from './safe-error';

/**
 * Everything the review screen is built from, as plain JSON.
 *
 * The maps travel as entries, so the same value crosses a `runner_probes.result`
 * column unchanged. `buildPreview` stays in the console and reads this shape
 * from either path, so the review screen cannot tell where it was inspected.
 */
export interface PreviewInspection {
  readonly targetDatabaseExists: boolean;
  readonly sourceSchema: DatabaseSchema;
  /** Empty when the destination database does not exist yet. */
  readonly targetSchema: DatabaseSchema;
  readonly diff: SchemaDiff;
  readonly plan: TableMigrationPlan;
  readonly rowEstimates: readonly (readonly [string, number])[];
  /** Empty means the engine could not say — not that the tables are empty. */
  readonly sizeEstimates: readonly (readonly [string, number])[];
}

/**
 * One end could not be reached. Which end, and what kind of failure, are the
 * whole diagnosis: "could not reach the destination" sends an operator to a
 * different screen than "could not reach the source", and a rejected password
 * is not an unreachable host.
 */
export class PreviewConnectionError extends Error {
  override readonly name = 'PreviewConnectionError';
  constructor(
    readonly side: 'source' | 'destination',
    readonly errorKind: ConnectionFailureKind,
    /** Already scrubbed of both passwords. */
    readonly text: string
  ) {
    super(text);
  }
}

/**
 * Inspect both ends, diff them and plan the copy order. Strictly read-only: it
 * creates nothing, not even the destination database, which is why
 * `targetDatabaseExists` is reported instead of being fixed silently.
 *
 * Throws `PreviewConnectionError` when an end cannot be reached. Every
 * connection it opened is closed whatever happens — a preview leaking a client
 * per click would take its host down long before anyone migrated anything.
 */
export async function inspectForPreview(
  sourceConfig: ConnectionConfig,
  destConfig: ConnectionConfig
): Promise<PreviewInspection> {
  const registry = buildRegistry();
  const sourceAdapters = registry.get(sourceConfig.type);
  const destAdapters = registry.get(destConfig.type);

  const sourceConnection = sourceAdapters.createConnection(sourceConfig);
  const destConnection = destAdapters.createConnection(destConfig);
  // Mirrors step 1 of the orchestrator: the destination database may not exist
  // yet, and finding that out is the admin connection's job.
  const adminConnection = destAdapters.createConnection({ ...destConfig, database: destAdapters.adminDatabase });

  const open: IDatabaseConnection[] = [];
  try {
    await connectOrFail(sourceConnection, 'source', sourceConfig);
    open.push(sourceConnection);

    const targetDatabaseExists = await destinationExists(destAdapters, adminConnection, destConfig.database, open);

    const sourceInspector = sourceAdapters.createSchemaInspector();
    const destInspector = destAdapters.createSchemaInspector();
    const synchronizer = destAdapters.createSchemaSynchronizer();
    // A real logger, so a failing inspection leaves a trace in the host's log.
    // None of it reaches the client.
    const logger = new ConsoleLogger('preview');

    let sourceSchema: DatabaseSchema;
    let targetSchema: DatabaseSchema;
    let diff: SchemaDiff;

    if (targetDatabaseExists) {
      await connectOrFail(destConnection, 'destination', destConfig);
      open.push(destConnection);
      const compared = await new CompareSchemasUseCase(sourceInspector, destInspector, synchronizer, logger)
        .execute(sourceConnection, destConnection);
      sourceSchema = compared.sourceSchema;
      targetSchema = compared.targetSchema;
      diff = compared.diff;
    } else {
      // Diffing against an empty schema is exactly what the run will do a
      // moment after it creates the database, so the preview stays truthful
      // rather than refusing the case it is most wanted for.
      sourceSchema = await sourceInspector.inspect(sourceConnection);
      targetSchema = { tables: [], sequences: [], enums: [] };
      diff = synchronizer.diff(sourceSchema, targetSchema);
    }

    const rowEstimates = await sourceInspector.getTableRowEstimates(sourceConnection);
    const plan = new TableMigrationPlanner().plan(sourceSchema.tables, rowEstimates);
    // Advisory: the inspector answers an empty map rather than failing the preview.
    const sizeEstimates = (await sourceInspector.getTableSizeEstimates?.(sourceConnection)) ?? new Map<string, number>();

    return {
      targetDatabaseExists,
      sourceSchema,
      targetSchema,
      diff,
      plan,
      rowEstimates: [...rowEstimates],
      sizeEstimates: [...sizeEstimates],
    };
  } finally {
    await Promise.all(open.map((connection) => connection.end().catch(() => {})));
  }
}

async function connectOrFail(
  connection: IDatabaseConnection,
  side: 'source' | 'destination',
  config: ConnectionConfig
): Promise<void> {
  try {
    await connection.connect();
  } catch (err) {
    const failure = describeConnectionFailure(err, config);
    throw new PreviewConnectionError(side, failure.kind, failure.text);
  }
}

/**
 * Whether the destination database is there yet.
 *
 * Asked through `listDatabases()` rather than by trying to connect and reading
 * the failure, because "the database does not exist" and "the credentials are
 * wrong" produce errors this code has no reliable way to tell apart — and
 * guessing wrong means telling someone their database is missing when their
 * password is stale. An engine that cannot list is assumed to have it, which
 * degrades to the destination connection's own specific error a moment later.
 */
async function destinationExists(
  adapters: DatabaseAdapterSet,
  adminConnection: IDatabaseConnection,
  database: string,
  open: IDatabaseConnection[]
): Promise<boolean> {
  if (!adapters.listDatabases) return true;
  try {
    await adminConnection.connect();
    open.push(adminConnection);
    const databases = await adapters.listDatabases(adminConnection);
    return databases.includes(database);
  } catch {
    return true;
  }
}
