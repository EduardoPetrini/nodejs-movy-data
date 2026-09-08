import {
  CompareSchemasUseCase, ConsoleLogger, TableMigrationPlanner, buildRegistry,
  type DatabaseSchema, type IDatabaseConnection, type SchemaDiff,
} from '@movy/core';
import { requirePermission } from '~~/server/utils/rbac';
import { toConnectionConfig, parseEngine } from '~~/server/utils/connection-config';
import { buildPreview } from '~~/server/definitions/build-preview';
import { resolveRunTarget } from '~~/server/runs/resolve-target';

/**
 * What this run would do, before it does any of it.
 *
 * Strictly read-only: it inspects both ends, diffs them and plans the copy
 * order. It creates nothing — not even the destination database, which is why
 * `targetDatabaseExists` is reported instead of being fixed silently.
 *
 * Called "preview", never "dry run". A dry run implies the real thing was
 * rehearsed; this only reads schemas. Applying remains all-or-nothing with no
 * rollback, and the warnings are where that is said out loud.
 *
 * `run:execute`, not `run:read`: this opens connections to two production
 * databases using stored credentials, which is a thing only someone who could
 * have launched the run should be able to make the server do.
 */
export default defineEventHandler(async (event) => {
  requirePermission(event, 'run:execute');

  const target = await resolveRunTarget(event, await readBody(event));
  const registry = buildRegistry();

  const sourceType = parseEngine(target.source.engine);
  const destType = parseEngine(target.target.engine);
  const sourceAdapters = registry.get(sourceType);
  const destAdapters = registry.get(destType);
  const translator = registry.getTranslator(sourceType, destType);

  const sourceConfig = toConnectionConfig(target.source, target.sourceDatabase);
  const destConfig = toConnectionConfig(target.target, target.targetDatabase);

  const sourceConnection = sourceAdapters.createConnection(sourceConfig);
  const destConnection = destAdapters.createConnection(destConfig);
  // Mirrors step 1 of the orchestrator: the destination database may not exist
  // yet, and finding that out is the admin connection's job.
  const adminConnection = destAdapters.createConnection({
    ...destConfig,
    database: destAdapters.adminDatabase,
  });

  const open: IDatabaseConnection[] = [];
  try {
    await connectOrFail(sourceConnection, 'source', target.source.engine);
    open.push(sourceConnection);

    const targetDatabaseExists = await destinationExists(
      destAdapters,
      adminConnection,
      destConfig.database,
      open
    );

    const sourceInspector = sourceAdapters.createSchemaInspector();
    const destInspector = destAdapters.createSchemaInspector();
    const synchronizer = destAdapters.createSchemaSynchronizer();
    // A real logger, so a failing inspection leaves a trace in the server log.
    // None of it reaches the client.
    const logger = new ConsoleLogger('preview');

    let sourceSchema: DatabaseSchema;
    let targetSchema: DatabaseSchema;
    let diff: SchemaDiff;

    if (targetDatabaseExists) {
      await connectOrFail(destConnection, 'destination', target.target.engine);
      open.push(destConnection);
      const compared = await new CompareSchemasUseCase(
        sourceInspector, destInspector, synchronizer, logger
      ).execute(sourceConnection, destConnection);
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

    return {
      preview: buildPreview({
        source: { engine: target.source.engine, database: sourceConfig.database },
        target: { engine: target.target.engine, database: destConfig.database },
        targetDatabaseExists,
        sourceSchema,
        targetSchema,
        diff,
        plan,
        rowEstimates,
        translateType: (type) => translator.translateColumnType(type, sourceType, destType),
      }),
    };
  } finally {
    // Every connection this handler opened, closed whatever happened. A
    // preview leaking a client per click would take the server down long
    // before anyone migrated anything.
    await Promise.all(open.map((connection) => connection.end().catch(() => {})));
  }
});

/**
 * Connect, or turn the driver's error into a 502 that names which end failed.
 *
 * Which end is the whole diagnosis: "could not reach the destination" sends
 * the operator to a different screen than "could not reach the source". The
 * driver's message is passed through — it carries host and port, which this
 * caller supplied and already has.
 */
async function connectOrFail(
  connection: IDatabaseConnection,
  side: 'source' | 'destination',
  engine: string
): Promise<void> {
  try {
    await connection.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw createError({
      statusCode: 502,
      statusMessage: `Could not reach the ${side} ${engine} database: ${message}`,
    });
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
  adapters: ReturnType<ReturnType<typeof buildRegistry>['get']>,
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
