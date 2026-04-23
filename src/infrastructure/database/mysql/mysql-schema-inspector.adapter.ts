import { ISchemaInspector } from '../../../domain/ports/schema-inspector.port';
import { IDatabaseConnection } from '../../../domain/ports/database.port';
import {
  DatabaseSchema,
  TableSchema,
  ColumnSchema,
  ConstraintSchema,
  IndexSchema,
} from '../../../domain/types/schema.types';
import { SchemaInspectionError } from '../../../domain/errors/migration.errors';

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  column_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  extra: string;
}

interface ConstraintRow {
  table_name: string;
  constraint_name: string;
  constraint_type: string;
  column_name: string;
  referenced_table: string | null;
  referenced_column: string | null;
  on_delete: string | null;
  on_update: string | null;
}

interface IndexRow {
  table_name: string;
  index_name: string;
  column_name: string;
  non_unique: number;
  seq_in_index: number;
}

interface TableRowEstimate {
  table_name: string;
  table_rows: number | null;
}

export class MysqlSchemaInspector implements ISchemaInspector {
  async inspect(connection: IDatabaseConnection, schemaName?: string): Promise<DatabaseSchema> {
    try {
      const db = schemaName ?? await this.resolveDatabase(connection);
      const [columnRows, constraintRows, indexRows] = await Promise.all([
        connection.query<ColumnRow>(COLUMNS_QUERY, [db, db]),
        connection.query<ConstraintRow>(CONSTRAINTS_QUERY, [db, db, db]),
        connection.query<IndexRow>(INDEXES_QUERY, [db]),
      ]);

      const tables = this.buildTables(columnRows, constraintRows, indexRows);
      return { tables, sequences: [], enums: [] };
    } catch (err) {
      if (err instanceof SchemaInspectionError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new SchemaInspectionError(`MySQL schema inspection failed: ${message}`);
    }
  }

  async getTableRowEstimates(connection: IDatabaseConnection): Promise<Map<string, number>> {
    const db = await this.resolveDatabase(connection);
    const rows = await connection.query<TableRowEstimate>(
      `SELECT TABLE_NAME as table_name, TABLE_ROWS as table_rows
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
      [db]
    );

    const estimates = new Map<string, number>();
    const tablesNeedingCount: string[] = [];

    for (const row of rows) {
      const est = row.table_rows ?? 0;
      if (est > 0) {
        estimates.set(row.table_name, est);
      } else {
        tablesNeedingCount.push(row.table_name);
      }
    }

    // Exact COUNT for tables with stale/missing estimates
    for (const table of tablesNeedingCount) {
      try {
        const countRows = await connection.query<{ count: string }>(
          `SELECT COUNT(*) as count FROM \`${table.replace(/`/g, '``')}\``
        );
        estimates.set(table, parseInt(countRows[0]?.count ?? '0', 10));
      } catch {
        estimates.set(table, 0);
      }
    }

    return estimates;
  }

  private async resolveDatabase(connection: IDatabaseConnection): Promise<string> {
    const rows = await connection.query<{ db: string }>(`SELECT DATABASE() as db`);
    const db = rows[0]?.db;
    if (!db) throw new SchemaInspectionError('Could not determine current MySQL database');
    return db;
  }

  private buildTables(
    columnRows: ColumnRow[],
    constraintRows: ConstraintRow[],
    indexRows: IndexRow[]
  ): TableSchema[] {
    const tableColumns = new Map<string, ColumnSchema[]>();
    for (const row of columnRows) {
      if (!tableColumns.has(row.table_name)) tableColumns.set(row.table_name, []);
      tableColumns.get(row.table_name)!.push(this.mapColumn(row));
    }

    const tableConstraints = this.buildConstraints(constraintRows);
    // Exclude indexes that back a constraint (UNIQUE, PK, FK) — they appear in both
    // information_schema.TABLE_CONSTRAINTS and STATISTICS, so they would otherwise
    // show up in both table.constraints and table.indexes, causing duplicate drops.
    const constraintNamesByTable = new Map<string, Set<string>>();
    for (const [tableName, constraints] of tableConstraints) {
      constraintNamesByTable.set(tableName, new Set(constraints.map((c) => c.name)));
    }
    const tableIndexes = this.buildIndexes(indexRows, constraintNamesByTable);

    const tableNames = [...tableColumns.keys()];
    return tableNames.map((name) => ({
      name,
      columns: tableColumns.get(name) ?? [],
      constraints: tableConstraints.get(name) ?? [],
      indexes: tableIndexes.get(name) ?? [],
    }));
  }

  private mapColumn(row: ColumnRow): ColumnSchema {
    // Use column_type for full type string (e.g. "tinyint(1)", "enum('a','b')")
    // Use data_type for the base type category
    return {
      name: row.column_name,
      dataType: row.column_type.toLowerCase(),
      isNullable: row.is_nullable === 'YES',
      defaultValue: this.normalizeDefault(row.column_default),
      characterMaxLength: row.character_maximum_length,
      numericPrecision: row.numeric_precision,
      numericScale: row.numeric_scale,
    };
  }

  /**
   * MySQL's information_schema.COLUMN_DEFAULT stores string defaults as bare
   * values without quotes (e.g. the stored default for `DEFAULT 'active'` is
   * just `active`). If passed as-is to PostgreSQL DDL the DB sees a column
   * reference, not a literal. This method quotes bare string values so that
   * downstream DDL builders and translators always receive well-formed SQL
   * default expressions.
   *
   * Leave unchanged:
   *   - null (no default)
   *   - already single-quoted strings
   *   - numeric literals (handled by the dialect translator: 0 → false, etc.)
   *   - known SQL keywords / function calls
   *   - bit literals (b'0') and hex literals (0x...)
   *   - expressions starting with '(' (computed defaults)
   */
  private normalizeDefault(value: string | null): string | null {
    if (value === null) return null;
    const v = value.trim();

    if (v.startsWith("'") && v.endsWith("'")) return value;
    if (v.startsWith('(')) return value;
    if (/^-?\d+(\.\d+)?$/.test(v)) return value;
    if (/^0x[0-9a-fA-F]+$/i.test(v)) return value;
    if (/^b'\d+'$/i.test(v)) return value;

    const SQL_KEYWORDS =
      /^(NULL|TRUE|FALSE|CURRENT_TIMESTAMP(\(\d*\))?|NOW\(\)|CURRENT_DATE|CURRENT_TIME|UUID\(\))$/i;
    if (SQL_KEYWORDS.test(v)) return value;

    // Bare string literal — wrap in single quotes, escaping any internal quotes.
    return `'${v.replace(/'/g, "''")}'`;
  }

  private buildConstraints(rows: ConstraintRow[]): Map<string, ConstraintSchema[]> {
    // Group by table + constraint name to merge multi-column constraints
    const grouped = new Map<string, Map<string, { row: ConstraintRow; columns: string[]; refCols: string[] }>>();

    for (const row of rows) {
      if (!grouped.has(row.table_name)) grouped.set(row.table_name, new Map());
      const tableMap = grouped.get(row.table_name)!;

      if (!tableMap.has(row.constraint_name)) {
        tableMap.set(row.constraint_name, { row, columns: [], refCols: [] });
      }
      const entry = tableMap.get(row.constraint_name)!;
      entry.columns.push(row.column_name);
      if (row.referenced_column) entry.refCols.push(row.referenced_column);
    }

    const result = new Map<string, ConstraintSchema[]>();
    for (const [tableName, tableMap] of grouped) {
      const constraints: ConstraintSchema[] = [];
      for (const { row, columns, refCols } of tableMap.values()) {
        const constraint = this.mapConstraint(row, columns, refCols);
        if (constraint) constraints.push(constraint);
      }
      result.set(tableName, constraints);
    }
    return result;
  }

  private mapConstraint(
    row: ConstraintRow,
    columns: string[],
    refCols: string[]
  ): ConstraintSchema | null {
    switch (row.constraint_type) {
      case 'PRIMARY KEY':
        return { name: row.constraint_name, type: 'PRIMARY KEY', columns };
      case 'UNIQUE':
        return { name: row.constraint_name, type: 'UNIQUE', columns };
      case 'FOREIGN KEY':
        return {
          name: row.constraint_name,
          type: 'FOREIGN KEY',
          columns,
          referencedTable: row.referenced_table ?? undefined,
          referencedColumns: refCols.length > 0 ? refCols : undefined,
          onDelete: row.on_delete ?? undefined,
          onUpdate: row.on_update ?? undefined,
        };
      default:
        return null;
    }
  }

  private buildIndexes(
    rows: IndexRow[],
    constraintNamesByTable: Map<string, Set<string>>
  ): Map<string, IndexSchema[]> {
    const grouped = new Map<string, Map<string, { nonUnique: number; columns: string[] }>>();

    for (const row of rows) {
      // Skip indexes that back a constraint — they are already represented in table.constraints.
      const constraintNames = constraintNamesByTable.get(row.table_name);
      if (constraintNames?.has(row.index_name)) continue;

      if (!grouped.has(row.table_name)) grouped.set(row.table_name, new Map());
      const tableMap = grouped.get(row.table_name)!;
      if (!tableMap.has(row.index_name)) {
        tableMap.set(row.index_name, { nonUnique: row.non_unique, columns: [] });
      }
      tableMap.get(row.index_name)!.columns.push(row.column_name);
    }

    const result = new Map<string, IndexSchema[]>();
    for (const [tableName, tableMap] of grouped) {
      const indexes: IndexSchema[] = [];
      for (const [name, { nonUnique, columns }] of tableMap) {
        indexes.push({ name, columns, isUnique: nonUnique === 0, method: 'btree' });
      }
      result.set(tableName, indexes);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// SQL queries
// ---------------------------------------------------------------------------

const COLUMNS_QUERY = `
SELECT
  c.TABLE_NAME         AS table_name,
  c.COLUMN_NAME        AS column_name,
  c.DATA_TYPE          AS data_type,
  c.COLUMN_TYPE        AS column_type,
  c.IS_NULLABLE        AS is_nullable,
  c.COLUMN_DEFAULT     AS column_default,
  c.CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
  c.NUMERIC_PRECISION  AS numeric_precision,
  c.NUMERIC_SCALE      AS numeric_scale,
  c.EXTRA              AS extra
FROM information_schema.COLUMNS c
JOIN information_schema.TABLES t
  ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
WHERE c.TABLE_SCHEMA = ?
  AND t.TABLE_TYPE = 'BASE TABLE'
  AND t.TABLE_SCHEMA = ?
ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
`;

const CONSTRAINTS_QUERY = `
SELECT
  tc.TABLE_NAME                       AS table_name,
  tc.CONSTRAINT_NAME                  AS constraint_name,
  tc.CONSTRAINT_TYPE                  AS constraint_type,
  kcu.COLUMN_NAME                     AS column_name,
  kcu.REFERENCED_TABLE_NAME           AS referenced_table,
  kcu.REFERENCED_COLUMN_NAME          AS referenced_column,
  rc.DELETE_RULE                      AS on_delete,
  rc.UPDATE_RULE                      AS on_update
FROM information_schema.TABLE_CONSTRAINTS tc
JOIN information_schema.KEY_COLUMN_USAGE kcu
  ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
  AND tc.TABLE_SCHEMA   = kcu.TABLE_SCHEMA
  AND tc.TABLE_NAME     = kcu.TABLE_NAME
LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
  ON tc.CONSTRAINT_NAME   = rc.CONSTRAINT_NAME
  AND tc.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
WHERE tc.TABLE_SCHEMA = ?
  AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
  AND kcu.TABLE_SCHEMA = ?
  AND kcu.CONSTRAINT_SCHEMA = ?
ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
`;

const INDEXES_QUERY = `
SELECT
  TABLE_NAME   AS table_name,
  INDEX_NAME   AS index_name,
  COLUMN_NAME  AS column_name,
  NON_UNIQUE   AS non_unique,
  SEQ_IN_INDEX AS seq_in_index
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ?
  AND INDEX_NAME != 'PRIMARY'
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
`;
