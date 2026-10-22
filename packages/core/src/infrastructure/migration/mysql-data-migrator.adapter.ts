import { IDataMigrator, MigrationProgressCallback } from '../../domain/ports/data-migrator.port.js';
import { ConnectionConfig } from '../../domain/types/connection.types.js';
import {
  MigrationResult,
  TableMigrationPlan,
  TableMigrationResult,
} from '../../domain/types/migration.types.js';
import { MysqlConnection } from '../database/mysql/mysql-connection.adapter.js';
import { throwIfCancelled, rethrowIfCancelled } from './cancellation.js';

const BATCH_SIZE = 500;

/**
 * Migrates data between two MySQL databases using batched SELECT + INSERT.
 * Uses a single destination session so FK checks can be controlled reliably.
 */
export class MysqlDataMigrator implements IDataMigrator {
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
    const source = new MysqlConnection(sourceConfig);
    const dest = new MysqlConnection(destConfig);

    try {
      await source.connect();
      await dest.connect();
      const destClient = await dest.getClient();

      try {
        await destClient.query('SET SESSION FOREIGN_KEY_CHECKS = 0');

        // Before emptying anything: clearing the destination is the most
        // destructive thing this migrator does, and a cancellation that arrived
        // while the schema step was still finishing must not be answered by
        // wiping every table and only then stopping. PgDataMigrator guards its
        // TRUNCATE the same way.
        throwIfCancelled(signal, 'before clearing the destination');

        for (const table of plan.cleanupOrder) {
          await this.clearDestinationTable(destClient, table);
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
        await destClient.query('SET SESSION FOREIGN_KEY_CHECKS = 1');
        destClient.release();
      }
    } finally {
      await Promise.allSettled([source.end(), dest.end()]);
    }
  }

  private async clearDestinationTable(destClient: Awaited<ReturnType<MysqlConnection['getClient']>>, table: string): Promise<void> {
    const safeTable = '`' + table.replace(/`/g, '``') + '`';

    try {
      await destClient.query(`TRUNCATE TABLE ${safeTable}`);
    } catch {
      await destClient.query(`DELETE FROM ${safeTable}`);
    }
  }

  private async copyTable(
    source: MysqlConnection,
    destClient: Awaited<ReturnType<MysqlConnection['getClient']>>,
    table: string,
    estimatedRows: number,
    onProgress: (done: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<number> {
    const safeTable = '`' + table.replace(/`/g, '``') + '`';

    // Fetch column names from source
    const columns = await this.getColumnNames(source, table);
    if (columns.length === 0) return 0;

    const colList = columns.map((c) => '`' + c.replace(/`/g, '``') + '`').join(', ');
    const placeholders = columns.map(() => '?').join(', ');

    let offset = 0;
    let totalCopied = 0;
    let lastReportedPct = -1;

    while (true) {
      throwIfCancelled(signal, `mid-copy of "${table}"`);
      const rows = await source.query<Record<string, unknown>>(
        `SELECT ${colList} FROM ${safeTable} LIMIT ${BATCH_SIZE} OFFSET ${offset}`
      );

      if (rows.length === 0) break;

      // Batch INSERT — build multi-row VALUES clause
      const values: unknown[] = [];
      const rowPlaceholders: string[] = [];
      for (const row of rows) {
        rowPlaceholders.push(`(${placeholders})`);
        for (const col of columns) values.push(row[col] ?? null);
      }

      await destClient.query(
        `INSERT INTO ${safeTable} (${colList}) VALUES ${rowPlaceholders.join(', ')}`,
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

    return totalCopied;
  }

  private async getColumnNames(connection: MysqlConnection, table: string): Promise<string[]> {
    const rows = await connection.query<{ Field: string }>(
      `SHOW COLUMNS FROM \`${table.replace(/`/g, '``')}\``
    );
    return rows.map((r) => r.Field);
  }
}
