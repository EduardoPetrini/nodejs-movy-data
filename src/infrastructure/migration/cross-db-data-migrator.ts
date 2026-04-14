import { pipeline } from 'stream/promises';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import mysql from 'mysql2/promise';
import { IDataMigrator, MigrationProgressCallback } from '../../domain/ports/data-migrator.port';
import { ConnectionConfig, DatabaseType } from '../../domain/types/connection.types';
import { MigrationResult, TableMigrationResult } from '../../domain/types/migration.types';
import { DataMigrationError } from '../../domain/errors/migration.errors';
import { MysqlConnection } from '../database/mysql/mysql-connection.adapter';
import { PgConnection } from '../database/pg/pg-connection.adapter';

const BATCH_SIZE = 500;

/**
 * Migrates data between two different database types (MySQL ↔ PostgreSQL).
 *
 * MySQL → PG:  streams SELECT rows from MySQL, batch-inserts into PG.
 * PG → MySQL:  reads PG rows via SELECT, batch-inserts into MySQL.
 *
 * Tables are processed sequentially. No worker threads are used, keeping
 * the implementation straightforward and correct.
 */
export class CrossDbDataMigrator implements IDataMigrator {
  async migrate(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    tables: string[],
    _workerCount: number,
    rowEstimates?: Map<string, number>,
    onProgress?: MigrationProgressCallback
  ): Promise<MigrationResult> {
    this.assertSupportedPair(sourceConfig.type, destConfig.type);

    const start = Date.now();
    const results: TableMigrationResult[] = [];

    for (const table of tables) {
      const tableStart = Date.now();
      const estimated = rowEstimates?.get(table) ?? 0;
      let rowsCopied = 0;
      let success = true;
      let error: string | undefined;

      try {
        if (isMysqlToPg(sourceConfig.type, destConfig.type)) {
          rowsCopied = await this.copyMysqlToPg(sourceConfig, destConfig, table, estimated, onProgress);
        } else {
          rowsCopied = await this.copyPgToMysql(sourceConfig, destConfig, table, estimated, onProgress);
        }
        onProgress?.(table, rowsCopied, rowsCopied);
      } catch (err) {
        success = false;
        error = err instanceof Error ? err.message : String(err);
      }

      results.push({ tableName: table, rowsCopied, durationMs: Date.now() - tableStart, success, error });
    }

    return {
      tables: results,
      totalDurationMs: Date.now() - start,
      success: results.every((r) => r.success),
    };
  }

  // ---------------------------------------------------------------------------
  // MySQL → PostgreSQL
  // ---------------------------------------------------------------------------

  private async copyMysqlToPg(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    table: string,
    estimatedRows: number,
    onProgress?: MigrationProgressCallback
  ): Promise<number> {
    const mysqlPool = mysql.createPool({
      host: sourceConfig.host,
      port: sourceConfig.port,
      user: sourceConfig.user,
      password: sourceConfig.password,
      database: sourceConfig.database,
    });
    const pgConn = new PgConnection(destConfig);
    await pgConn.connect();

    try {
      const safeTable = '`' + table.replace(/`/g, '``') + '`';

      // Get column names from MySQL
      const [fieldRows] = await mysqlPool.execute(`SHOW COLUMNS FROM ${safeTable}`);
      const columns = (fieldRows as Array<{ Field: string }>).map((r) => r.Field);
      if (columns.length === 0) return 0;

      const pgColList = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

      // Truncate PG table
      await pgConn.query(`TRUNCATE TABLE "${table.replace(/"/g, '""')}"`);

      let offset = 0;
      let totalCopied = 0;
      let lastReportedPct = -1;

      while (true) {
        const [rows] = await mysqlPool.execute(
          `SELECT * FROM ${safeTable} LIMIT ${BATCH_SIZE} OFFSET ${offset}`
        );
        const rowArray = rows as Array<Record<string, unknown>>;
        if (rowArray.length === 0) break;

        // Batch INSERT into PG
        for (const row of rowArray) {
          const values = columns.map((c) => row[c] ?? null);
          await pgConn.query(
            `INSERT INTO "${table.replace(/"/g, '""')}" (${pgColList}) VALUES (${placeholders})`,
            values
          );
        }

        totalCopied += rowArray.length;
        offset += rowArray.length;

        if (estimatedRows > 0) {
          const pct = Math.floor((totalCopied / estimatedRows) * 100);
          if (pct !== lastReportedPct && pct % 10 === 0) {
            onProgress?.(table, totalCopied, estimatedRows);
            lastReportedPct = pct;
          }
        }

        if (rowArray.length < BATCH_SIZE) break;
      }

      return totalCopied;
    } finally {
      await Promise.allSettled([mysqlPool.end(), pgConn.end()]);
    }
  }

  // ---------------------------------------------------------------------------
  // PostgreSQL → MySQL
  // ---------------------------------------------------------------------------

  private async copyPgToMysql(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    table: string,
    estimatedRows: number,
    onProgress?: MigrationProgressCallback
  ): Promise<number> {
    const pgConn = new PgConnection(sourceConfig);
    await pgConn.connect();
    const mysqlPool = mysql.createPool({
      host: destConfig.host,
      port: destConfig.port,
      user: destConfig.user,
      password: destConfig.password,
      database: destConfig.database,
    });

    try {
      const safePgTable = `"${table.replace(/"/g, '""')}"`;
      const safeMysqlTable = '`' + table.replace(/`/g, '``') + '`';

      // Get column names from PG
      const colRows = await pgConn.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [table]
      );
      const columns = colRows.map((r) => r.column_name);
      if (columns.length === 0) return 0;

      const mysqlColList = columns.map((c) => '`' + c.replace(/`/g, '``') + '`').join(', ');
      const placeholders = columns.map(() => '?').join(', ');

      // Truncate MySQL table
      await mysqlPool.execute(`TRUNCATE TABLE ${safeMysqlTable}`);

      let offset = 0;
      let totalCopied = 0;
      let lastReportedPct = -1;

      while (true) {
        const pgColList = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
        const rows = await pgConn.query<Record<string, unknown>>(
          `SELECT ${pgColList} FROM ${safePgTable} LIMIT ${BATCH_SIZE} OFFSET ${offset}`
        );

        if (rows.length === 0) break;

        // Batch INSERT into MySQL
        const rowPlaceholders = rows.map(() => `(${placeholders})`).join(', ');
        const values: unknown[] = [];
        for (const row of rows) {
          for (const col of columns) values.push(row[col] ?? null);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await mysqlPool.execute(
          `INSERT INTO ${safeMysqlTable} (${mysqlColList}) VALUES ${rowPlaceholders}`,
          values as any
        );

        totalCopied += rows.length;
        offset += rows.length;

        if (estimatedRows > 0) {
          const pct = Math.floor((totalCopied / estimatedRows) * 100);
          if (pct !== lastReportedPct && pct % 10 === 0) {
            onProgress?.(table, totalCopied, estimatedRows);
            lastReportedPct = pct;
          }
        }

        if (rows.length < BATCH_SIZE) break;
      }

      return totalCopied;
    } finally {
      await Promise.allSettled([pgConn.end(), mysqlPool.end()]);
    }
  }

  private assertSupportedPair(source: DatabaseType, dest: DatabaseType): void {
    const supported =
      (source === DatabaseType.MYSQL && dest === DatabaseType.POSTGRES) ||
      (source === DatabaseType.POSTGRES && dest === DatabaseType.MYSQL);

    if (!supported) {
      throw new DataMigrationError(
        `Cross-database migration not supported: ${source} → ${dest}. ` +
          `Supported pairs: MySQL↔PostgreSQL.`
      );
    }
  }
}

function isMysqlToPg(source: DatabaseType, dest: DatabaseType): boolean {
  return source === DatabaseType.MYSQL && dest === DatabaseType.POSTGRES;
}
