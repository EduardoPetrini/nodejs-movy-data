import { IDataMigrator, MigrationProgressCallback } from '../../domain/ports/data-migrator.port';
import { IDbClient } from '../../domain/ports/database.port';
import { ConnectionConfig, DatabaseType } from '../../domain/types/connection.types';
import {
  MigrationResult,
  TableMigrationPlan,
  TableMigrationResult,
} from '../../domain/types/migration.types';
import { DataMigrationError } from '../../domain/errors/migration.errors';
import { MssqlConnection } from '../database/mssql/mssql-connection.adapter';
import { PgConnection } from '../database/pg/pg-connection.adapter';
import { MysqlConnection } from '../database/mysql/mysql-connection.adapter';

const BATCH_SIZE = 500;
const DEFAULT_SCHEMA_MSSQL = 'dbo';

function escapeId(name: string): string {
  return '[' + name.replace(/]/g, ']]') + ']';
}

/**
 * Handles all cross-database migration pairs that involve MSSQL:
 * MSSQL ↔ PostgreSQL and MSSQL ↔ MySQL.
 *
 * The existing CrossDbDataMigrator (MySQL ↔ PG) remains unchanged (OCP).
 */
export class MssqlCrossDbDataMigrator implements IDataMigrator {
  async migrate(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    plan: TableMigrationPlan,
    _workerCount: number,
    rowEstimates?: Map<string, number>,
    onProgress?: MigrationProgressCallback
  ): Promise<MigrationResult> {
    this.assertSupportedPair(sourceConfig.type, destConfig.type);

    const start = Date.now();
    const results: TableMigrationResult[] = [];

    for (const table of plan.loadOrder) {
      const tableStart = Date.now();
      const estimated = rowEstimates?.get(table) ?? 0;
      let rowsCopied = 0;
      let success = true;
      let error: string | undefined;

      try {
        rowsCopied = await this.copyTable(sourceConfig, destConfig, plan, table, estimated, onProgress);
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

  private async copyTable(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    plan: TableMigrationPlan,
    table: string,
    estimatedRows: number,
    onProgress?: MigrationProgressCallback
  ): Promise<number> {
    const { type: srcType } = sourceConfig;
    const { type: dstType } = destConfig;

    if (srcType === DatabaseType.MSSQL && dstType === DatabaseType.POSTGRES) {
      return this.copyMssqlToPg(sourceConfig, destConfig, plan, table, estimatedRows, onProgress);
    }
    if (srcType === DatabaseType.MSSQL && dstType === DatabaseType.MYSQL) {
      return this.copyMssqlToMysql(sourceConfig, destConfig, plan, table, estimatedRows, onProgress);
    }
    if (srcType === DatabaseType.POSTGRES && dstType === DatabaseType.MSSQL) {
      return this.copyPgToMssql(sourceConfig, destConfig, plan, table, estimatedRows, onProgress);
    }
    if (srcType === DatabaseType.MYSQL && dstType === DatabaseType.MSSQL) {
      return this.copyMysqlToMssql(sourceConfig, destConfig, plan, table, estimatedRows, onProgress);
    }
    throw new DataMigrationError(`Unsupported pair: ${srcType} → ${dstType}`);
  }

  // ---------------------------------------------------------------------------
  // MSSQL → PostgreSQL
  // ---------------------------------------------------------------------------

  private async copyMssqlToPg(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    plan: TableMigrationPlan,
    table: string,
    estimatedRows: number,
    onProgress?: MigrationProgressCallback
  ): Promise<number> {
    const source = new MssqlConnection(sourceConfig);
    const dest = new PgConnection(destConfig);
    await source.connect();
    await dest.connect();

    try {
      if (plan.cleanupOrder.includes(table)) {
        await dest.query(`TRUNCATE TABLE "${table.replace(/"/g, '""')}" CASCADE`);
      }

      const columns = await this.getMssqlColumns(source, table);
      if (columns.length === 0) return 0;

      const pgColList = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

      return this.paginateMssql(source, table, columns, estimatedRows, async (rows) => {
        for (const row of rows) {
          const values = columns.map((c) => row[c] ?? null);
          await dest.query(
            `INSERT INTO "${table.replace(/"/g, '""')}" (${pgColList}) VALUES (${placeholders})`,
            values
          );
        }
      }, (done, total) => onProgress?.(table, done, total));
    } finally {
      await Promise.allSettled([source.end(), dest.end()]);
    }
  }

  // ---------------------------------------------------------------------------
  // MSSQL → MySQL
  // ---------------------------------------------------------------------------

  private async copyMssqlToMysql(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    plan: TableMigrationPlan,
    table: string,
    estimatedRows: number,
    onProgress?: MigrationProgressCallback
  ): Promise<number> {
    const source = new MssqlConnection(sourceConfig);
    const dest = new MysqlConnection(destConfig);
    await source.connect();
    await dest.connect();
    const destClient = await dest.getClient();

    try {
      await destClient.query('SET SESSION FOREIGN_KEY_CHECKS = 0');
      if (plan.cleanupOrder.includes(table)) {
        await this.clearMysqlTable(destClient, table);
      }

      const columns = await this.getMssqlColumns(source, table);
      if (columns.length === 0) return 0;

      const mysqlColList = columns.map((c) => '`' + c.replace(/`/g, '``') + '`').join(', ');
      const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;

      return this.paginateMssql(source, table, columns, estimatedRows, async (rows) => {
        const values: unknown[] = [];
        const rowPlaceholders = rows.map(() => rowPlaceholder);
        for (const row of rows) {
          for (const col of columns) values.push(row[col] ?? null);
        }
        await destClient.query(
          `INSERT INTO \`${table.replace(/`/g, '``')}\` (${mysqlColList}) VALUES ${rowPlaceholders.join(', ')}`,
          values
        );
      }, (done, total) => onProgress?.(table, done, total));
    } finally {
      await destClient.query('SET SESSION FOREIGN_KEY_CHECKS = 1');
      destClient.release();
      await Promise.allSettled([source.end(), dest.end()]);
    }
  }

  // ---------------------------------------------------------------------------
  // PostgreSQL → MSSQL
  // ---------------------------------------------------------------------------

  private async copyPgToMssql(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    plan: TableMigrationPlan,
    table: string,
    estimatedRows: number,
    onProgress?: MigrationProgressCallback
  ): Promise<number> {
    const source = new PgConnection(sourceConfig);
    const dest = new MssqlConnection(destConfig);
    await source.connect();
    await dest.connect();
    const destClient = await dest.getClient();

    try {
      await destClient.query(`ALTER TABLE ${escapeId(table)} NOCHECK CONSTRAINT ALL`);
      if (plan.cleanupOrder.includes(table)) {
        await this.clearMssqlTable(destClient, table);
      }

      const colRows = await source.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [table]
      );
      const columns = colRows.map((r) => r.column_name);
      if (columns.length === 0) return 0;

      const identityColumns = await this.getMssqlIdentityColumns(dest, table);
      const hasIdentity = identityColumns.length > 0;
      if (hasIdentity) await destClient.query(`SET IDENTITY_INSERT ${escapeId(table)} ON`);

      const colList = columns.map(escapeId).join(', ');
      const placeholder = `(${columns.map(() => '?').join(', ')})`;

      let offset = 0;
      let totalCopied = 0;
      let lastReportedPct = -1;

      try {
        while (true) {
          const pgColList = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
          const rows = await source.query<Record<string, unknown>>(
            `SELECT ${pgColList} FROM "${table.replace(/"/g, '""')}" LIMIT ${BATCH_SIZE} OFFSET ${offset}`
          );
          if (rows.length === 0) break;

          const values: unknown[] = [];
          const rowPlaceholders = rows.map(() => placeholder);
          for (const row of rows) {
            for (const col of columns) values.push(row[col] ?? null);
          }
          await destClient.query(
            `INSERT INTO ${escapeId(table)} (${colList}) VALUES ${rowPlaceholders.join(', ')}`,
            values
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
      } finally {
        if (hasIdentity) await destClient.query(`SET IDENTITY_INSERT ${escapeId(table)} OFF`);
      }

      return totalCopied;
    } finally {
      await destClient.query(`ALTER TABLE ${escapeId(table)} WITH CHECK CHECK CONSTRAINT ALL`);
      destClient.release();
      await Promise.allSettled([source.end(), dest.end()]);
    }
  }

  // ---------------------------------------------------------------------------
  // MySQL → MSSQL
  // ---------------------------------------------------------------------------

  private async copyMysqlToMssql(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    plan: TableMigrationPlan,
    table: string,
    estimatedRows: number,
    onProgress?: MigrationProgressCallback
  ): Promise<number> {
    const source = new MysqlConnection(sourceConfig);
    const dest = new MssqlConnection(destConfig);
    await source.connect();
    await dest.connect();
    const destClient = await dest.getClient();

    try {
      await destClient.query(`ALTER TABLE ${escapeId(table)} NOCHECK CONSTRAINT ALL`);
      if (plan.cleanupOrder.includes(table)) {
        await this.clearMssqlTable(destClient, table);
      }

      const colRows = await source.query<{ Field: string }>(
        `SHOW COLUMNS FROM \`${table.replace(/`/g, '``')}\``
      );
      const columns = colRows.map((r) => r.Field);
      if (columns.length === 0) return 0;

      const identityColumns = await this.getMssqlIdentityColumns(dest, table);
      const hasIdentity = identityColumns.length > 0;
      if (hasIdentity) await destClient.query(`SET IDENTITY_INSERT ${escapeId(table)} ON`);

      const mssqlColList = columns.map(escapeId).join(', ');
      const placeholder = `(${columns.map(() => '?').join(', ')})`;

      let offset = 0;
      let totalCopied = 0;
      let lastReportedPct = -1;

      try {
        while (true) {
          const mysqlColList = columns.map((c) => '`' + c.replace(/`/g, '``') + '`').join(', ');
          const rows = await source.query<Record<string, unknown>>(
            `SELECT ${mysqlColList} FROM \`${table.replace(/`/g, '``')}\` LIMIT ${BATCH_SIZE} OFFSET ${offset}`
          );
          if (rows.length === 0) break;

          const values: unknown[] = [];
          const rowPlaceholders = rows.map(() => placeholder);
          for (const row of rows) {
            for (const col of columns) values.push(row[col] ?? null);
          }
          await destClient.query(
            `INSERT INTO ${escapeId(table)} (${mssqlColList}) VALUES ${rowPlaceholders.join(', ')}`,
            values
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
      } finally {
        if (hasIdentity) await destClient.query(`SET IDENTITY_INSERT ${escapeId(table)} OFF`);
      }

      return totalCopied;
    } finally {
      await destClient.query(`ALTER TABLE ${escapeId(table)} WITH CHECK CHECK CONSTRAINT ALL`);
      destClient.release();
      await Promise.allSettled([source.end(), dest.end()]);
    }
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  private async getMssqlColumns(connection: MssqlConnection, table: string): Promise<string[]> {
    const rows = await connection.query<{ column_name: string }>(
      `SELECT COLUMN_NAME AS column_name
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = '${DEFAULT_SCHEMA_MSSQL}' AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [table]
    );
    return rows.map((r) => r.column_name);
  }

  private async getMssqlIdentityColumns(connection: MssqlConnection, table: string): Promise<string[]> {
    const rows = await connection.query<{ column_name: string }>(
      `SELECT COLUMN_NAME AS column_name
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = '${DEFAULT_SCHEMA_MSSQL}'
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

  private async paginateMssql(
    source: MssqlConnection,
    table: string,
    columns: string[],
    estimatedRows: number,
    processRows: (rows: Record<string, unknown>[]) => Promise<void>,
    onProgress: (done: number, total: number) => void
  ): Promise<number> {
    const colList = columns.map(escapeId).join(', ');
    const escapedTable = escapeId(table);
    let offset = 0;
    let totalCopied = 0;
    let lastReportedPct = -1;

    while (true) {
      const rows = await source.query<Record<string, unknown>>(
        `SELECT ${colList} FROM ${escapedTable}
         ORDER BY (SELECT NULL)
         OFFSET ${offset} ROWS FETCH NEXT ${BATCH_SIZE} ROWS ONLY`
      );
      if (rows.length === 0) break;

      await processRows(rows);

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

  private async clearMssqlTable(client: IDbClient, table: string): Promise<void> {
    try {
      await client.query(`TRUNCATE TABLE ${escapeId(table)}`);
    } catch {
      await client.query(`DELETE FROM ${escapeId(table)}`);
    }
  }

  private async clearMysqlTable(client: IDbClient, table: string): Promise<void> {
    const safeTable = '`' + table.replace(/`/g, '``') + '`';
    try {
      await client.query(`TRUNCATE TABLE ${safeTable}`);
    } catch {
      await client.query(`DELETE FROM ${safeTable}`);
    }
  }

  private assertSupportedPair(source: DatabaseType, dest: DatabaseType): void {
    const supported =
      source === DatabaseType.MSSQL ||
      dest === DatabaseType.MSSQL;

    if (!supported) {
      throw new DataMigrationError(
        `MssqlCrossDbDataMigrator only handles pairs involving MSSQL. Got: ${source} → ${dest}.`
      );
    }

    const validPairs =
      (source === DatabaseType.MSSQL && (dest === DatabaseType.POSTGRES || dest === DatabaseType.MYSQL)) ||
      ((source === DatabaseType.POSTGRES || source === DatabaseType.MYSQL) && dest === DatabaseType.MSSQL);

    if (!validPairs) {
      throw new DataMigrationError(
        `Unsupported migration pair: ${source} → ${dest}.`
      );
    }
  }
}
