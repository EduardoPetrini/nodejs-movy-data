import { IDataMigrator, MigrationProgressCallback } from '../../domain/ports/data-migrator.port.js';
import { IDbClient } from '../../domain/ports/database.port.js';
import { ConnectionConfig } from '../../domain/types/connection.types.js';
import {
  MigrationResult,
  TableMigrationPlan,
  TableMigrationResult,
} from '../../domain/types/migration.types.js';
import { MssqlConnection } from '../database/mssql/mssql-connection.adapter.js';
import { throwIfCancelled, rethrowIfCancelled } from './cancellation.js';

const BATCH_SIZE = 500;
const DEFAULT_SCHEMA = 'dbo';

function escapeId(name: string): string {
  return '[' + name.replace(/]/g, ']]') + ']';
}

export class MssqlDataMigrator implements IDataMigrator {
  async migrate(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    plan: TableMigrationPlan,
    _workerCount: number,
    rowEstimates?: Map<string, number>,
    onProgress?: MigrationProgressCallback,
    signal?: AbortSignal
  ): Promise<MigrationResult> {
    const start = Date.now();
    const source = new MssqlConnection(sourceConfig);
    const dest = new MssqlConnection(destConfig);

    try {
      await source.connect();
      await dest.connect();
      const destClient = await dest.getClient();

      try {
        await this.noCheckAllTables(destClient, plan.cleanupOrder);

        // Before emptying anything: clearing the destination is the most
        // destructive thing this migrator does, and a cancellation that arrived
        // while the schema step was still finishing must not be answered by
        // wiping every table and only then stopping. PgDataMigrator guards its
        // TRUNCATE the same way.
        throwIfCancelled(signal, 'before clearing the destination');

        for (const table of plan.cleanupOrder) {
          await this.clearTable(destClient, table);
        }

        const results: TableMigrationResult[] = [];

        for (const table of plan.loadOrder) {
          throwIfCancelled(signal, `before copying "${table}"`);
          const tableStart = Date.now();
          const estimated = rowEstimates?.get(table) ?? 0;
          let rowsCopied = 0;
          let success = true;
          let error: string | undefined;

          try {
            rowsCopied = await this.copyTable(source, destClient, table, estimated, (done, total) => {
              onProgress?.(table, done, total);
            }, signal);
            onProgress?.(table, rowsCopied, rowsCopied);
          } catch (err) {
            // A cancellation is not a table outcome — it ends the run.
            rethrowIfCancelled(err);
            success = false;
            error = err instanceof Error ? err.message : String(err);
          }

          results.push({ tableName: table, rowsCopied, durationMs: Date.now() - tableStart, success, error });

          // The copy loop breaks out on a short final batch without looking at
          // the signal again, so an abort landing during the last batch of the
          // last table would otherwise never be seen and this would return
          // success: true for a run somebody cancelled.
          throwIfCancelled(signal, `after copying "${table}"`);
        }

        return {
          tables: results,
          totalDurationMs: Date.now() - start,
          success: results.every((r) => r.success),
        };
      } finally {
        await this.checkAllTables(destClient, plan.cleanupOrder);
        destClient.release();
      }
    } finally {
      await Promise.allSettled([source.end(), dest.end()]);
    }
  }

  private async noCheckAllTables(client: IDbClient, tables: string[]): Promise<void> {
    for (const table of tables) {
      await client.query(`ALTER TABLE ${escapeId(table)} NOCHECK CONSTRAINT ALL`);
    }
  }

  private async checkAllTables(client: IDbClient, tables: string[]): Promise<void> {
    for (const table of tables) {
      try {
        await client.query(`ALTER TABLE ${escapeId(table)} WITH CHECK CHECK CONSTRAINT ALL`);
      } catch {
        // Best-effort re-enable — do not mask the original error
      }
    }
  }

  private async clearTable(client: IDbClient, table: string): Promise<void> {
    try {
      await client.query(`TRUNCATE TABLE ${escapeId(table)}`);
    } catch {
      await client.query(`DELETE FROM ${escapeId(table)}`);
    }
  }

  private async copyTable(
    source: MssqlConnection,
    destClient: IDbClient,
    table: string,
    estimatedRows: number,
    onProgress: (done: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<number> {
    const columns = await this.getColumnNames(source, table);
    if (columns.length === 0) return 0;

    const identityColumns = await this.getIdentityColumns(source, table);
    const hasIdentity = identityColumns.length > 0;

    const escapedTable = escapeId(table);
    const colList = columns.map(escapeId).join(', ');
    const placeholders = columns.map(() => '?').join(', ');

    if (hasIdentity) {
      await destClient.query(`SET IDENTITY_INSERT ${escapedTable} ON`);
    }

    let offset = 0;
    let totalCopied = 0;
    let lastReportedPct = -1;

    try {
      while (true) {
        throwIfCancelled(signal, `mid-copy of "${table}"`);
        const rows = await source.query<Record<string, unknown>>(
          `SELECT ${colList} FROM ${escapedTable}
           ORDER BY (SELECT NULL)
           OFFSET ${offset} ROWS FETCH NEXT ${BATCH_SIZE} ROWS ONLY`
        );

        if (rows.length === 0) break;

        const values: unknown[] = [];
        const rowPlaceholders: string[] = [];
        for (const row of rows) {
          rowPlaceholders.push(`(${placeholders})`);
          for (const col of columns) values.push(row[col] ?? null);
        }

        await destClient.query(
          `INSERT INTO ${escapedTable} (${colList}) VALUES ${rowPlaceholders.join(', ')}`,
          values
        );

        totalCopied += rows.length;
        offset += rows.length;

        if (estimatedRows > 0) {
          const pct = Math.floor((totalCopied / estimatedRows) * 100);
          if (pct !== lastReportedPct && pct % 10 === 0) {
            onProgress(totalCopied, estimatedRows);
            lastReportedPct = pct;
          }
        }

        if (rows.length < BATCH_SIZE) break;
      }
    } finally {
      if (hasIdentity) {
        await destClient.query(`SET IDENTITY_INSERT ${escapedTable} OFF`);
      }
    }

    return totalCopied;
  }

  private async getColumnNames(connection: MssqlConnection, table: string): Promise<string[]> {
    const rows = await connection.query<{ column_name: string }>(
      `SELECT COLUMN_NAME AS column_name
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = '${DEFAULT_SCHEMA}' AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [table]
    );
    return rows.map((r) => r.column_name);
  }

  private async getIdentityColumns(connection: MssqlConnection, table: string): Promise<string[]> {
    const rows = await connection.query<{ column_name: string }>(
      `SELECT COLUMN_NAME AS column_name
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = '${DEFAULT_SCHEMA}'
         AND TABLE_NAME = ?
         AND COLUMNPROPERTY(
           OBJECT_ID(TABLE_SCHEMA + '.' + TABLE_NAME),
           COLUMN_NAME,
           'IsIdentity'
         ) = 1`,
      [table]
    );
    return rows.map((r) => r.column_name);
  }
}
