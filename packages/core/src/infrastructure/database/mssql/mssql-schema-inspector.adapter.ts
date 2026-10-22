import { ISchemaInspector } from '../../../domain/ports/schema-inspector.port.js';
import { IDatabaseConnection } from '../../../domain/ports/database.port.js';
import {
  DatabaseSchema,
  TableSchema,
  ColumnSchema,
  ConstraintSchema,
  IndexSchema,
} from '../../../domain/types/schema.types.js';
import { SchemaInspectionError } from '../../../domain/errors/migration.errors.js';
import { toRowCount } from '../../../shared/utils.js';

const DEFAULT_SCHEMA = 'dbo';

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_identity: number;
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
  is_unique: boolean | number;
  seq_in_index: number;
  index_type: string;
}

interface RowEstimateRow {
  table_name: string;
  row_count: number | null;
}

export class MssqlSchemaInspector implements ISchemaInspector {
  async inspect(connection: IDatabaseConnection, schemaName?: string): Promise<DatabaseSchema> {
    try {
      const schema = schemaName ?? DEFAULT_SCHEMA;
      const [columnRows, constraintRows, indexRows] = await Promise.all([
        connection.query<ColumnRow>(COLUMNS_QUERY, [schema]),
        connection.query<ConstraintRow>(CONSTRAINTS_QUERY, [schema, schema, schema]),
        connection.query<IndexRow>(INDEXES_QUERY, [schema]),
      ]);

      const tables = this.buildTables(columnRows, constraintRows, indexRows);
      return { tables, sequences: [], enums: [] };
    } catch (err) {
      if (err instanceof SchemaInspectionError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new SchemaInspectionError(`MSSQL schema inspection failed: ${message}`);
    }
  }

  async getTableRowEstimates(connection: IDatabaseConnection, schemaName?: string): Promise<Map<string, number>> {
    const schema = schemaName ?? DEFAULT_SCHEMA;
    const rows = await connection.query<RowEstimateRow>(ROW_ESTIMATES_QUERY, [schema]);

    const estimates = new Map<string, number>();
    for (const row of rows) {
      estimates.set(row.table_name, toRowCount(row.row_count));
    }
    return estimates;
  }

  private buildTables(
    columnRows: ColumnRow[],
    constraintRows: ConstraintRow[],
    indexRows: IndexRow[],
  ): TableSchema[] {
    const tableColumns = new Map<string, ColumnSchema[]>();
    for (const row of columnRows) {
      if (!tableColumns.has(row.table_name)) tableColumns.set(row.table_name, []);
      tableColumns.get(row.table_name)!.push(this.mapColumn(row));
    }

    const tableConstraints = this.buildConstraints(constraintRows);
    const constraintNamesByTable = new Map<string, Set<string>>();
    for (const [tableName, constraints] of tableConstraints) {
      constraintNamesByTable.set(tableName, new Set(constraints.map((c) => c.name)));
    }
    const tableIndexes = this.buildIndexes(indexRows, constraintNamesByTable);

    return [...tableColumns.keys()].map((name) => ({
      name,
      columns: tableColumns.get(name) ?? [],
      constraints: tableConstraints.get(name) ?? [],
      indexes: tableIndexes.get(name) ?? [],
    }));
  }

  private mapColumn(row: ColumnRow): ColumnSchema {
    return {
      name: row.column_name,
      dataType: this.buildDataType(row),
      isNullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      characterMaxLength: row.character_maximum_length,
      numericPrecision: row.numeric_precision,
      numericScale: row.numeric_scale,
      autoIncrement: row.is_identity === 1,
    };
  }

  private buildDataType(row: ColumnRow): string {
    const base = row.data_type.toLowerCase();
    if (row.character_maximum_length != null) {
      const len = row.character_maximum_length === -1 ? 'max' : String(row.character_maximum_length);
      return `${base}(${len})`;
    }
    if (row.numeric_precision != null && row.numeric_scale != null &&
        (base === 'decimal' || base === 'numeric')) {
      return `${base}(${row.numeric_precision},${row.numeric_scale})`;
    }
    return base;
  }

  private buildConstraints(rows: ConstraintRow[]): Map<string, ConstraintSchema[]> {
    const grouped = new Map<string, Map<string, { row: ConstraintRow; columns: string[]; refCols: string[] }>>();

    for (const row of rows) {
      if (!grouped.has(row.table_name)) grouped.set(row.table_name, new Map());
      const tableMap = grouped.get(row.table_name)!;

      if (!tableMap.has(row.constraint_name)) {
        tableMap.set(row.constraint_name, { row, columns: [], refCols: [] });
      }
      const entry = tableMap.get(row.constraint_name)!;
      if (!entry.columns.includes(row.column_name)) entry.columns.push(row.column_name);
      if (row.referenced_column && !entry.refCols.includes(row.referenced_column)) {
        entry.refCols.push(row.referenced_column);
      }
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
    const grouped = new Map<string, Map<string, { isUnique: boolean; columns: string[]; method: string }>>();

    for (const row of rows) {
      const constraintNames = constraintNamesByTable.get(row.table_name);
      if (constraintNames?.has(row.index_name)) continue;

      if (!grouped.has(row.table_name)) grouped.set(row.table_name, new Map());
      const tableMap = grouped.get(row.table_name)!;
      if (!tableMap.has(row.index_name)) {
        tableMap.set(row.index_name, {
          isUnique: Boolean(row.is_unique),
          columns: [],
          method: row.index_type?.toLowerCase() ?? 'btree',
        });
      }
      tableMap.get(row.index_name)!.columns.push(row.column_name);
    }

    const result = new Map<string, IndexSchema[]>();
    for (const [tableName, tableMap] of grouped) {
      const indexes: IndexSchema[] = [];
      for (const [name, { isUnique, columns, method }] of tableMap) {
        indexes.push({ name, columns, isUnique, method });
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
  c.TABLE_NAME                                      AS table_name,
  c.COLUMN_NAME                                     AS column_name,
  c.DATA_TYPE                                       AS data_type,
  c.IS_NULLABLE                                     AS is_nullable,
  c.COLUMN_DEFAULT                                  AS column_default,
  c.CHARACTER_MAXIMUM_LENGTH                        AS character_maximum_length,
  c.NUMERIC_PRECISION                               AS numeric_precision,
  c.NUMERIC_SCALE                                   AS numeric_scale,
  COLUMNPROPERTY(
    OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME),
    c.COLUMN_NAME,
    'IsIdentity'
  )                                                 AS is_identity
FROM INFORMATION_SCHEMA.COLUMNS c
JOIN INFORMATION_SCHEMA.TABLES t
  ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
WHERE c.TABLE_SCHEMA = @p0
  AND t.TABLE_TYPE = 'BASE TABLE'
ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
`;

const CONSTRAINTS_QUERY = `
SELECT
  tc.TABLE_NAME         AS table_name,
  tc.CONSTRAINT_NAME    AS constraint_name,
  tc.CONSTRAINT_TYPE    AS constraint_type,
  kcu.COLUMN_NAME       AS column_name,
  ccu.TABLE_NAME        AS referenced_table,
  ccu.COLUMN_NAME       AS referenced_column,
  rc.DELETE_RULE        AS on_delete,
  rc.UPDATE_RULE        AS on_update
FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
  ON  tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
  AND tc.TABLE_SCHEMA      = kcu.TABLE_SCHEMA
  AND tc.TABLE_NAME        = kcu.TABLE_NAME
LEFT JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
  ON  tc.CONSTRAINT_NAME   = rc.CONSTRAINT_NAME
  AND tc.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ccu
  ON  rc.UNIQUE_CONSTRAINT_NAME = ccu.CONSTRAINT_NAME
  AND rc.UNIQUE_CONSTRAINT_SCHEMA = ccu.CONSTRAINT_SCHEMA
  AND kcu.ORDINAL_POSITION  = ccu.ORDINAL_POSITION
WHERE tc.TABLE_SCHEMA = @p0
  AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
  AND kcu.TABLE_SCHEMA = @p1
  AND kcu.CONSTRAINT_SCHEMA = @p2
ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
`;

const INDEXES_QUERY = `
SELECT
  t.name         AS table_name,
  i.name         AS index_name,
  c.name         AS column_name,
  i.is_unique    AS is_unique,
  ic.key_ordinal AS seq_in_index,
  i.type_desc    AS index_type
FROM sys.tables t
JOIN sys.indexes i
  ON  t.object_id = i.object_id
JOIN sys.index_columns ic
  ON  i.object_id  = ic.object_id
  AND i.index_id   = ic.index_id
JOIN sys.columns c
  ON  ic.object_id = c.object_id
  AND ic.column_id = c.column_id
WHERE SCHEMA_NAME(t.schema_id) = @p0
  AND i.is_primary_key = 0
  AND i.type_desc <> 'HEAP'
  AND ic.is_included_column = 0
ORDER BY t.name, i.name, ic.key_ordinal
`;

const ROW_ESTIMATES_QUERY = `
SELECT
  t.name        AS table_name,
  SUM(p.rows)   AS row_count
FROM sys.tables t
JOIN sys.partitions p
  ON  t.object_id = p.object_id
WHERE p.index_id IN (0, 1)
  AND SCHEMA_NAME(t.schema_id) = @p0
GROUP BY t.name
`;
