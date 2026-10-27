import { IDbClient } from '../../domain/ports/database.port.js';

/** SQL Server refuses a request carrying more parameters than this. */
export const MSSQL_MAX_PARAMS = 2100;

/** Below the cap with room to spare, so a future extra parameter cannot tip it. */
const PARAM_BUDGET = 2000;

/** SQL Server's limit on the rows of one VALUES list. */
const MAX_VALUES_ROWS = 1000;

function escapeId(name: string): string {
  return '[' + name.replace(/]/g, ']]') + ']';
}

/**
 * How many rows one multi-row INSERT may carry for a table this wide.
 *
 * Every value is a parameter, so a fixed row count is a parameter count that
 * grows with the table: the migrators' 500-row batch is 2,500 parameters at
 * five columns, which SQL Server rejects outright. Every table wider than four
 * columns failed to copy into SQL Server for that reason alone.
 */
export function mssqlRowsPerInsert(columnCount: number): number {
  return Math.max(1, Math.min(MAX_VALUES_ROWS, Math.floor(PARAM_BUDGET / Math.max(1, columnCount))));
}

/**
 * Inserts a batch read from the source, split into statements SQL Server
 * accepts. Rows go in the order given, on the caller's client, so session state
 * such as `SET IDENTITY_INSERT … ON` applies to every statement.
 */
export async function insertMssqlRows(
  client: IDbClient,
  escapedTable: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  const colList = columns.map(escapeId).join(', ');
  const placeholder = `(${columns.map(() => '?').join(', ')})`;
  const perInsert = mssqlRowsPerInsert(columns.length);

  for (let start = 0; start < rows.length; start += perInsert) {
    const chunk = rows.slice(start, start + perInsert);
    const values = chunk.flatMap((row) => columns.map((col) => row[col] ?? null));
    await client.query(
      `INSERT INTO ${escapedTable} (${colList}) VALUES ${chunk.map(() => placeholder).join(', ')}`,
      values
    );
  }
}
