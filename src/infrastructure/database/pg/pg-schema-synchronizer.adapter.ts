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
import { escapeIdentifier } from '../../../shared/utils';

// PostgreSQL types that accept a length/precision modifier via characterMaxLength.
// All other types ignore it — e.g. "text" is always unlimited.
const PG_LENGTH_SUPPORTING_TYPES = new Set([
  'char', 'character', 'varchar', 'character varying',
  'bit', 'bit varying', 'varbit',
]);

export class PgSchemaSynchronizer implements ISchemaSynchronizer {
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
    const sequencesToCreate: SequenceSchema[] = [];
    const enumsToCreate: EnumSchema[] = [];

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

    const targetSeqNames = new Set(target.sequences.map((s) => s.name));
    for (const seq of source.sequences) {
      if (!targetSeqNames.has(seq.name)) {
        sequencesToCreate.push(seq);
      }
    }

    const targetEnumNames = new Set(target.enums.map((e) => e.name));
    for (const e of source.enums) {
      if (!targetEnumNames.has(e.name)) {
        enumsToCreate.push(e);
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
      sequencesToCreate,
      enumsToCreate,
    };
  }

  async apply(connection: IDatabaseConnection, diff: SchemaDiff): Promise<void> {
    const statements: string[] = [];

    for (const e of diff.enumsToCreate) {
      const values = e.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
      statements.push(`CREATE TYPE ${escapeIdentifier(e.name)} AS ENUM (${values});`);
    }

    for (const seq of diff.sequencesToCreate) {
      statements.push(this.buildCreateSequence(seq));
    }

    for (const table of diff.tablesToCreate) {
      statements.push(this.buildCreateTable(table));
    }

    // Drop constraints and indexes before dropping columns so that dependent
    // objects don't block or silently reshape when the column is removed.
    for (const { tableName, constraintName } of diff.constraintsToDrop) {
      statements.push(
        `ALTER TABLE ${escapeIdentifier(tableName)} DROP CONSTRAINT IF EXISTS ${escapeIdentifier(constraintName)};`
      );
    }

    for (const { tableName, indexName } of diff.indexesToDrop) {
      statements.push(`DROP INDEX IF EXISTS ${escapeIdentifier(indexName)};`);
    }

    for (const { tableName, columnName } of diff.columnsToDrop) {
      statements.push(
        `ALTER TABLE ${escapeIdentifier(tableName)} DROP COLUMN IF EXISTS ${escapeIdentifier(columnName)};`
      );
    }

    for (const { tableName, column } of diff.columnsToAdd) {
      statements.push(
        `ALTER TABLE ${escapeIdentifier(tableName)} ADD COLUMN ${this.buildColumnDef(column)};`
      );
    }

    for (const { tableName, diff: colDiff } of diff.columnsToAlter) {
      statements.push(
        `ALTER TABLE ${escapeIdentifier(tableName)} ALTER COLUMN ${escapeIdentifier(colDiff.columnName)} TYPE ${this.quoteTypeIfNeeded(colDiff.sourceType)};`
      );
    }

    for (const { tableName, constraint } of diff.constraintsToAdd) {
      statements.push(
        `ALTER TABLE ${escapeIdentifier(tableName)} ADD ${this.buildConstraintDef(constraint, tableName)};`
      );
    }

    for (const tableName of diff.tablesToDrop) {
      statements.push(`DROP TABLE IF EXISTS ${escapeIdentifier(tableName)};`);
    }

    if (statements.length === 0) return;

    const client = await connection.getClient();
    try {
      await client.query('BEGIN');
      for (const stmt of statements) {
        await client.query(stmt);
      }
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore rollback errors */ }
      const message = err instanceof Error ? err.message : String(err);
      throw new SchemaSyncError(`Schema sync failed: ${message}`);
    } finally {
      client.release();
    }
  }

  async disableTriggers(connection: IDatabaseConnection, tables: string[]): Promise<void> {
    for (const table of tables) {
      await connection.query(
        `ALTER TABLE ${escapeIdentifier(table)} DISABLE TRIGGER ALL`
      );
    }
  }

  async enableTriggers(connection: IDatabaseConnection, tables: string[]): Promise<void> {
    for (const table of tables) {
      await connection.query(
        `ALTER TABLE ${escapeIdentifier(table)} ENABLE TRIGGER ALL`
      );
    }
  }

  async createIndexes(connection: IDatabaseConnection, diff: SchemaDiff): Promise<void> {
    for (const { tableName, index } of diff.indexesToCreate) {
      const unique = index.isUnique ? 'UNIQUE ' : '';
      const cols = index.columns.map(escapeIdentifier).join(', ');
      const sql = `CREATE ${unique}INDEX IF NOT EXISTS ${escapeIdentifier(index.name)} ON ${escapeIdentifier(tableName)} USING ${index.method} (${cols});`;
      try {
        await connection.query(sql);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`WARN: Failed to create index ${index.name}: ${message}`);
      }
    }
  }

  async resetSequences(
    source: IDatabaseConnection,
    dest: IDatabaseConnection,
    sequences: SequenceSchema[]
  ): Promise<void> {
    for (const seq of sequences) {
      try {
        const rows = await source.query<{ last_value: string }>(
          `SELECT last_value::text FROM ${escapeIdentifier(seq.name)}`
        );
        const lastValue = rows[0]?.last_value;
        if (lastValue !== undefined && lastValue !== null) {
          await dest.query(`SELECT setval($1, $2, true)`, [seq.name, lastValue]);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`WARN: Failed to reset sequence ${seq.name}: ${message}`);
      }
    }
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
        // Embed characterMaxLength so translators can propagate the length
        // when the source type string doesn't carry it (e.g. PG "character varying").
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
    const inlineConstraints = table.constraints
      .filter((c) => c.type === 'PRIMARY KEY' || c.type === 'UNIQUE')
      .map((c) => `  ${this.buildConstraintDef(c, table.name)}`);

    const lines = [...colDefs, ...inlineConstraints];
    return `CREATE TABLE IF NOT EXISTS ${escapeIdentifier(table.name)} (\n${lines.join(',\n')}\n);`;
  }

  private buildColumnDef(col: ColumnSchema): string {
    const typeLiteral = this.quoteTypeIfNeeded(col.dataType);
    // Only append characterMaxLength when:
    // 1. The type doesn't already carry an inline precision (e.g. translated "varchar(255)")
    // 2. The base type actually supports a length modifier in PG (e.g. not "text", "integer")
    const baseType = col.dataType.replace(/\s*\(.*\)$/, '').trim().toLowerCase();
    const needsLength =
      col.characterMaxLength &&
      !col.dataType.includes('(') &&
      PG_LENGTH_SUPPORTING_TYPES.has(baseType);
    let def = needsLength
      ? `${escapeIdentifier(col.name)} ${typeLiteral}(${col.characterMaxLength})`
      : `${escapeIdentifier(col.name)} ${typeLiteral}`;
    if (!col.isNullable) def += ' NOT NULL';
    if (col.defaultValue !== null) def += ` DEFAULT ${col.defaultValue}`;
    return def;
  }

  /** Quote a type name only when it contains uppercase letters (user-defined mixed-case types). */
  private quoteTypeIfNeeded(dataType: string): string {
    return dataType !== dataType.toLowerCase() ? escapeIdentifier(dataType) : dataType;
  }

  private buildConstraintDef(constraint: ConstraintSchema, tableName?: string): string {
    const cols = constraint.columns.map(escapeIdentifier).join(', ');
    // MySQL names every PK "PRIMARY"; that name must be unique per schema in PG
    // (it backs an index), so rewrite it to the standard PG convention.
    const resolvedName =
      constraint.name === 'PRIMARY' && tableName ? `${tableName}_pkey` : constraint.name;
    const name = `CONSTRAINT ${escapeIdentifier(resolvedName)}`;

    switch (constraint.type) {
      case 'PRIMARY KEY':
        return `${name} PRIMARY KEY (${cols})`;
      case 'UNIQUE':
        return `${name} UNIQUE (${cols})`;
      case 'FOREIGN KEY': {
        const refTable = escapeIdentifier(constraint.referencedTable!);
        const refCols = (constraint.referencedColumns ?? []).map(escapeIdentifier).join(', ');
        let def = `${name} FOREIGN KEY (${cols}) REFERENCES ${refTable} (${refCols})`;
        if (constraint.onDelete) def += ` ON DELETE ${constraint.onDelete}`;
        if (constraint.onUpdate) def += ` ON UPDATE ${constraint.onUpdate}`;
        return def;
      }
      case 'CHECK':
        return `${name} CHECK (${constraint.checkExpression})`;
      default:
        throw new SchemaSyncError(`Unknown constraint type: ${(constraint as ConstraintSchema).type}`);
    }
  }

  private buildCreateSequence(seq: SequenceSchema): string {
    return [
      `CREATE SEQUENCE IF NOT EXISTS ${escapeIdentifier(seq.name)}`,
      `  START WITH ${seq.startValue}`,
      `  INCREMENT BY ${seq.incrementBy}`,
      `  MINVALUE ${seq.minValue}`,
      `  MAXVALUE ${seq.maxValue}`,
      seq.cycleOption ? '  CYCLE' : '  NO CYCLE',
      ';',
    ].join('\n');
  }
}
