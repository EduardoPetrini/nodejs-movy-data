import { ISchemaSynchronizer } from '../../../domain/ports/schema-synchronizer.port';
import { IDatabaseConnection } from '../../../domain/ports/database.port';
import {
  DatabaseSchema,
  TableSchema,
  ColumnSchema,
  ConstraintSchema,
  IndexSchema,
  SequenceSchema,
  EnumSchema,
} from '../../../domain/types/schema.types';
import { SchemaDiff } from '../../../domain/types/migration.types';
import { SchemaSyncError } from '../../../domain/errors/migration.errors';

/** Escapes a MySQL identifier with backticks. */
function escapeId(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

/**
 * Quotes a default value for use in DDL if it is a plain string literal.
 * Numeric values, SQL keywords (NULL, CURRENT_TIMESTAMP, etc.), and already-quoted
 * strings are left untouched.
 */
function quoteDefault(value: string): string {
  // Already single-quoted
  if (value.startsWith("'") && value.endsWith("'")) return value;
  // Numeric
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  // Known SQL keywords / expressions that must NOT be quoted
  const keywords = /^(NULL|TRUE|FALSE|CURRENT_TIMESTAMP(\(\d*\))?|NOW\(\)|CURRENT_DATE|CURRENT_TIME|UUID\(\)|1|0)$/i;
  if (keywords.test(value)) return value;
  // Everything else is a string literal — wrap in single quotes
  return `'${value.replace(/'/g, "\\'")}'`;
}

export class MysqlSchemaSynchronizer implements ISchemaSynchronizer {
  diff(source: DatabaseSchema, target: DatabaseSchema): SchemaDiff {
    const targetTableMap = new Map(target.tables.map((t) => [t.name, t]));
    const sourceTableMap = new Map(source.tables.map((t) => [t.name, t]));

    const tablesToCreate: TableSchema[] = [];
    const tablesToDrop: string[] = [];
    const columnsToAdd: SchemaDiff['columnsToAdd'] = [];
    const columnsToDrop: SchemaDiff['columnsToDrop'] = [];
    const columnsToAlter: SchemaDiff['columnsToAlter'] = [];
    const constraintsToAdd: SchemaDiff['constraintsToAdd'] = [];
    const constraintsToDrop: SchemaDiff['constraintsToDrop'] = [];
    const indexesToCreate: SchemaDiff['indexesToCreate'] = [];
    const indexesToDrop: SchemaDiff['indexesToDrop'] = [];

    for (const sourceTable of source.tables) {
      const targetTable = targetTableMap.get(sourceTable.name);
      if (!targetTable) {
        tablesToCreate.push(sourceTable);
        continue;
      }
      this.diffColumns(sourceTable, targetTable, columnsToAdd, columnsToDrop, columnsToAlter);
      this.diffConstraints(sourceTable, targetTable, constraintsToAdd, constraintsToDrop);
      this.diffIndexes(sourceTable, targetTable, indexesToCreate, indexesToDrop);
    }

    for (const targetTable of target.tables) {
      if (!sourceTableMap.has(targetTable.name)) {
        tablesToDrop.push(targetTable.name);
      }
    }

    return {
      tablesToCreate,
      tablesToDrop,
      columnsToAdd,
      columnsToDrop,
      columnsToAlter,
      constraintsToAdd,
      constraintsToDrop,
      indexesToCreate,
      indexesToDrop,
      sequencesToCreate: [], // MySQL has no standalone sequences
      enumsToCreate: [],     // MySQL enums are inline column definitions
    };
  }

  async apply(connection: IDatabaseConnection, diff: SchemaDiff): Promise<void> {
    const statements: string[] = [];

    // MySQL DDL auto-commits, so we execute statements sequentially.
    // Constraints and indexes that reference a column must be dropped BEFORE the column is
    // dropped — otherwise MySQL tries to keep composite indexes alive with the remaining
    // columns and throws a "Duplicate entry" error when those columns are not unique.
    for (const table of diff.tablesToCreate) {
      statements.push(this.buildCreateTable(table));
    }

    // Drop constraints and indexes before dropping columns.
    // MySQL does not support IF EXISTS on DROP FOREIGN KEY at all.
    // ALTER TABLE ... DROP INDEX IF EXISTS ... was only added in MySQL 8.0.29;
    // use the older "DROP INDEX IF EXISTS name ON table" form for broader compatibility.
    // FKs have a backing index with the same name that must also be dropped explicitly.
    for (const { tableName, constraintName, constraintType } of diff.constraintsToDrop) {
      if (constraintType === 'FOREIGN KEY') {
        statements.push(
          `ALTER TABLE ${escapeId(tableName)} DROP FOREIGN KEY ${escapeId(constraintName)};`,
          `DROP INDEX IF EXISTS ${escapeId(constraintName)} ON ${escapeId(tableName)};`
        );
      } else {
        // PRIMARY KEY, UNIQUE, CHECK — stored as indexes in MySQL
        statements.push(
          `DROP INDEX IF EXISTS ${escapeId(constraintName)} ON ${escapeId(tableName)};`
        );
      }
    }

    for (const { tableName, indexName } of diff.indexesToDrop) {
      statements.push(
        `DROP INDEX IF EXISTS ${escapeId(indexName)} ON ${escapeId(tableName)};`
      );
    }

    for (const { tableName, columnName } of diff.columnsToDrop) {
      statements.push(
        `ALTER TABLE ${escapeId(tableName)} DROP COLUMN ${escapeId(columnName)};`
      );
    }

    for (const { tableName, column } of diff.columnsToAdd) {
      statements.push(
        `ALTER TABLE ${escapeId(tableName)} ADD COLUMN ${this.buildColumnDef(column)};`
      );
    }

    for (const { tableName, diff: colDiff } of diff.columnsToAlter) {
      statements.push(
        `ALTER TABLE ${escapeId(tableName)} MODIFY COLUMN ${escapeId(colDiff.columnName)} ${colDiff.sourceType};`
      );
    }

    for (const { tableName, constraint } of diff.constraintsToAdd) {
      const def = this.buildConstraintDef(constraint);
      if (def) {
        statements.push(`ALTER TABLE ${escapeId(tableName)} ADD ${def};`);
      }
    }

    for (const tableName of diff.tablesToDrop) {
      statements.push(`DROP TABLE IF EXISTS ${escapeId(tableName)};`);
    }

    for (const stmt of statements) {
      try {
        await connection.query(stmt);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new SchemaSyncError(`Schema sync failed on statement:\n${stmt}\n\nError: ${message}`);
      }
    }
  }

  /** MySQL does not support DISABLE TRIGGER ALL — use FK check disabling instead. */
  async disableTriggers(connection: IDatabaseConnection, _tables: string[]): Promise<void> {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
  }

  async enableTriggers(connection: IDatabaseConnection, _tables: string[]): Promise<void> {
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  async createIndexes(connection: IDatabaseConnection, diff: SchemaDiff): Promise<void> {
    for (const { tableName, index } of diff.indexesToCreate) {
      const unique = index.isUnique ? 'UNIQUE ' : '';
      const cols = index.columns.map(escapeId).join(', ');
      const sql = `CREATE ${unique}INDEX ${escapeId(index.name)} ON ${escapeId(tableName)} (${cols});`;
      try {
        await connection.query(sql);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`WARN: Failed to create index ${index.name}: ${message}`);
      }
    }
  }

  /** MySQL AUTO_INCREMENT is managed per-table; sequences are a no-op. */
  async resetSequences(
    _source: IDatabaseConnection,
    _dest: IDatabaseConnection,
    _sequences: SequenceSchema[]
  ): Promise<void> {
    // No-op: MySQL does not have standalone sequences.
  }

  async ensureDatabase(adminConnection: IDatabaseConnection, dbName: string): Promise<boolean> {
    const rows = await adminConnection.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
      [dbName]
    );
    if ((rows[0]?.count ?? 0) > 0) return false;
    await adminConnection.query(
      `CREATE DATABASE \`${dbName.replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    return true;
  }

  private diffColumns(
    source: TableSchema,
    target: TableSchema,
    toAdd: SchemaDiff['columnsToAdd'],
    toDrop: SchemaDiff['columnsToDrop'],
    toAlter: SchemaDiff['columnsToAlter']
  ): void {
    const targetCols = new Map(target.columns.map((c) => [c.name, c]));
    const sourceCols = new Map(source.columns.map((c) => [c.name, c]));

    for (const col of source.columns) {
      const targetCol = targetCols.get(col.name);
      if (!targetCol) {
        toAdd.push({ tableName: source.name, column: col });
      } else if (col.dataType !== targetCol.dataType) {
        // Embed characterMaxLength into the type string so the translator can
        // propagate it (e.g. "character varying" + 36 → "character varying(36)"
        // → translated to "varchar(36)"). Without this the length is lost and
        // MySQL rejects bare "varchar" in MODIFY COLUMN.
        const sourceType =
          col.characterMaxLength && !col.dataType.includes('(')
            ? `${col.dataType}(${col.characterMaxLength})`
            : col.dataType;
        toAlter.push({
          tableName: source.name,
          diff: { columnName: col.name, sourceType, targetType: targetCol.dataType },
        });
      }
    }

    for (const col of target.columns) {
      if (!sourceCols.has(col.name)) {
        toDrop.push({ tableName: source.name, columnName: col.name });
      }
    }
  }

  private diffConstraints(
    source: TableSchema,
    target: TableSchema,
    toAdd: SchemaDiff['constraintsToAdd'],
    toDrop: SchemaDiff['constraintsToDrop']
  ): void {
    const targetConstraints = new Map(target.constraints.map((c) => [c.name, c]));
    const sourceConstraints = new Map(source.constraints.map((c) => [c.name, c]));

    for (const constraint of source.constraints) {
      if (!targetConstraints.has(constraint.name)) {
        toAdd.push({ tableName: source.name, constraint });
      }
    }

    for (const constraint of target.constraints) {
      if (!sourceConstraints.has(constraint.name)) {
        toDrop.push({ tableName: source.name, constraintName: constraint.name, constraintType: constraint.type });
      }
    }
  }

  private diffIndexes(
    source: TableSchema,
    target: TableSchema,
    toCreate: SchemaDiff['indexesToCreate'],
    toDrop: SchemaDiff['indexesToDrop']
  ): void {
    const targetIndexes = new Map(target.indexes.map((i) => [i.name, i]));
    const sourceIndexes = new Map(source.indexes.map((i) => [i.name, i]));

    for (const index of source.indexes) {
      if (!targetIndexes.has(index.name)) {
        toCreate.push({ tableName: source.name, index });
      }
    }

    for (const index of target.indexes) {
      if (!sourceIndexes.has(index.name)) {
        toDrop.push({ tableName: source.name, indexName: index.name });
      }
    }
  }

  private buildCreateTable(table: TableSchema): string {
    const colDefs = table.columns.map((c) => `  ${this.buildColumnDef(c)}`);
    const colTypeMap = new Map(table.columns.map((c) => [c.name, c.dataType]));
    const inlineConstraints = table.constraints
      .filter((c) => c.type === 'PRIMARY KEY' || c.type === 'UNIQUE')
      .map((c) => {
        const def = this.buildConstraintDef(c, colTypeMap);
        return def ? `  ${def}` : null;
      })
      .filter((x): x is string => x !== null);

    const lines = [...colDefs, ...inlineConstraints];
    return (
      `CREATE TABLE IF NOT EXISTS ${escapeId(table.name)} (\n${lines.join(',\n')}\n)` +
      ` ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`
    );
  }

  private buildColumnDef(col: ColumnSchema): string {
    let typePart = col.dataType;

    // Preserve char/varchar length if available
    if ((col.dataType === 'char' || col.dataType === 'varchar') && col.characterMaxLength) {
      typePart = `${col.dataType}(${col.characterMaxLength})`;
    }

    let def = `${escapeId(col.name)} ${typePart}`;
    if (!col.isNullable) def += ' NOT NULL';
    if (col.defaultValue !== null) def += ` DEFAULT ${quoteDefault(col.defaultValue)}`;
    return def;
  }

  private buildConstraintDef(
    constraint: ConstraintSchema,
    colTypeMap: Map<string, string> = new Map()
  ): string | null {
    const name = escapeId(constraint.name);

    /** Renders a column reference, adding a prefix length for TEXT/BLOB types. */
    const colRef = (colName: string): string => {
      const type = colTypeMap.get(colName) ?? '';
      if (/^(text|tinytext|mediumtext|longtext|blob|tinyblob|mediumblob|longblob)$/i.test(type)) {
        return `${escapeId(colName)}(255)`;
      }
      return escapeId(colName);
    };

    const cols = constraint.columns.map(colRef).join(', ');

    switch (constraint.type) {
      case 'PRIMARY KEY':
        return `CONSTRAINT ${name} PRIMARY KEY (${cols})`;
      case 'UNIQUE':
        return `CONSTRAINT ${name} UNIQUE (${cols})`;
      case 'FOREIGN KEY': {
        const refTable = escapeId(constraint.referencedTable!);
        const refCols = (constraint.referencedColumns ?? []).map(escapeId).join(', ');
        let def = `CONSTRAINT ${name} FOREIGN KEY (${cols}) REFERENCES ${refTable} (${refCols})`;
        if (constraint.onDelete) def += ` ON DELETE ${constraint.onDelete}`;
        if (constraint.onUpdate) def += ` ON UPDATE ${constraint.onUpdate}`;
        return def;
      }
      case 'CHECK':
        // MySQL 8.0.16+ supports CHECK constraints
        return `CONSTRAINT ${name} CHECK (${constraint.checkExpression})`;
      default:
        return null;
    }
  }
}
