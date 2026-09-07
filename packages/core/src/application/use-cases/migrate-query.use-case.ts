import { pipeline } from 'stream/promises';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import type { PoolClient } from 'pg';
import { IQueryAnalyzer, QueryColumn } from '../../domain/ports/query-analyzer.port';
import { ISchemaSynchronizer } from '../../domain/ports/schema-synchronizer.port';
import { IDatabaseConnection } from '../../domain/ports/database.port';
import { ILogger } from '../../domain/ports/logger.port';
import { TableSchema, ColumnSchema } from '../../domain/types/schema.types';
import { SchemaDiff, MigrationResult } from '../../domain/types/migration.types';
import { PgConnection } from '../../infrastructure/database/pg/pg-connection.adapter';

// Map analyzed type names to valid PostgreSQL DDL type names
function toDdlType(typeName: string): string {
  const map: Record<string, string> = {
    int4: 'integer',
    int8: 'bigint',
    int2: 'smallint',
    float4: 'real',
    float8: 'double precision',
    bool: 'boolean',
    timestamptz: 'timestamp with time zone',
    timestamp: 'timestamp without time zone',
  };
  return map[typeName] ?? typeName;
}

function buildEmptySchemaDiff(tableToCreate: TableSchema): SchemaDiff {
  return {
    tablesToCreate: [tableToCreate],
    tablesToDrop: [],
    columnsToAdd: [],
    columnsToDrop: [],
    columnsToAlter: [],
    constraintsToAdd: [],
    constraintsToDrop: [],
    indexesToCreate: [],
    indexesToDrop: [],
    sequencesToCreate: [],
    enumsToCreate: [],
  };
}

export class MigrateQueryUseCase {
  constructor(
    private readonly analyzer: IQueryAnalyzer,
    private readonly synchronizer: ISchemaSynchronizer,
    private readonly logger: ILogger
  ) {}

  async execute(
    sourceConnection: IDatabaseConnection,
    destConnection: IDatabaseConnection,
    query: string,
    targetTableName: string
  ): Promise<MigrationResult> {
    const start = Date.now();

    // Step 1: Analyze the query to get column info
    this.logger.info('Analyzing query result schema...');
    let columns: QueryColumn[];
    try {
      columns = await this.analyzer.analyzeQuery(sourceConnection, query);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Query analysis failed: ${message}`);
    }

    if (columns.length === 0) {
      throw new Error('Query returned no columns — cannot create destination table.');
    }

    // Step 2: Log the inferred schema
    const maxColLen = Math.max(...columns.map((c) => c.name.length), 6);
    this.logger.info(`\nInferred schema for table "${targetTableName}":`);
    for (const col of columns) {
      this.logger.info(`  ${col.name.padEnd(maxColLen + 2)} ${toDdlType(col.typeName)}`);
    }
    this.logger.info('  Note: No primary key or foreign keys are inferred from query results.\n');

    // Step 3: Build a TableSchema and create the table in destination
    const columnSchemas: ColumnSchema[] = columns.map((col) => ({
      name: col.name,
      dataType: toDdlType(col.typeName),
      isNullable: true,
      defaultValue: null,
      characterMaxLength: null,
      numericPrecision: null,
      numericScale: null,
    }));

    const tableSchema: TableSchema = {
      name: targetTableName,
      columns: columnSchemas,
      constraints: [],
      indexes: [],
    };

    const diff = buildEmptySchemaDiff(tableSchema);
    this.logger.info(`Creating table "${targetTableName}" in destination...`);
    await this.synchronizer.apply(destConnection, diff);
    this.logger.info(`Table "${targetTableName}" created.`);

    // Step 4: Stream data via COPY (PostgreSQL-specific)
    this.logger.info(`Copying data from query into "${targetTableName}"...`);
    const rowsCopied = await this.streamData(sourceConnection, destConnection, query, targetTableName);

    const durationMs = Date.now() - start;
    this.logger.info(`Done. ${rowsCopied.toLocaleString()} rows copied in ${Math.round(durationMs / 1000)}s.`);

    return {
      tables: [{ tableName: targetTableName, rowsCopied, durationMs, success: true }],
      totalDurationMs: durationMs,
      success: true,
    };
  }

  private async streamData(
    sourceConn: IDatabaseConnection,
    destConn: IDatabaseConnection,
    query: string,
    targetTableName: string
  ): Promise<number> {
    // This method requires PostgreSQL connections with COPY stream support.
    // The CLI already guards this behind a PG-source-only check.
    const sourcePgConn = sourceConn as PgConnection;
    const destPgConn = destConn as PgConnection;

    const sourceClient: PoolClient = await sourcePgConn.getPoolClient();
    const destClient: PoolClient = await destPgConn.getPoolClient();

    try {
      const sourceStream = sourceClient.query(copyTo(`COPY (${query}) TO STDOUT`));
      const destStream = destClient.query(copyFrom(`COPY ${JSON.stringify(targetTableName)} FROM STDIN`));

      let rowCount = 0;
      sourceStream.on('data', (chunk: Buffer) => {
        rowCount += chunk.toString().split('\n').filter((l) => l.length > 0).length;
      });

      await pipeline(sourceStream, destStream);
      return rowCount;
    } finally {
      sourceClient.release();
      destClient.release();
    }
  }
}
