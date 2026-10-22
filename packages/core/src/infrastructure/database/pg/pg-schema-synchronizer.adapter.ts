import { ISchemaSynchronizer } from '../../../domain/ports/schema-synchronizer.port.js';
import { IDatabaseConnection } from '../../../domain/ports/database.port.js';
import {
  DatabaseSchema,
  TableSchema,
  ColumnSchema,
  ConstraintSchema,
  IndexSchema,
  SequenceSchema,
  EnumSchema,
} from '../../../domain/types/schema.types.js';
import { SchemaDiff } from '../../../domain/types/migration.types.js';
import { SchemaSyncError } from '../../../domain/errors/migration.errors.js';
import { escapeIdentifier } from '../../../shared/utils.js';

// PostgreSQL types that accept a length/precision modifier via characterMaxLength.
// All other types ignore it — e.g. "text" is always unlimited.
const PG_LENGTH_SUPPORTING_TYPES = new Set([
  'char', 'character', 'varchar', 'character varying',
  'bit', 'bit varying', 'varbit',
]);

/** What the source sequence would hand out next, if it could be read. */
interface SourceCounter {
  lastValue: string;
  isCalled: boolean;
}

/** The next value a source counter would produce, as a bigint literal. */
function nextValueOf(counter: SourceCounter | undefined): string | undefined {
  if (!counter) return undefined;
  try {
    return (BigInt(counter.lastValue) + (counter.isCalled ? 1n : 0n)).toString();
  } catch {
    return undefined; // not a number we can reason about; the rows still bound it
  }
}

interface RawColumnSequence {
  sequence_name: string;
  table_name: string;
  column_name: string;
}

/**
 * Every sequence in the current schema that stands behind a column, in the two
 * shapes PostgreSQL records them. A `serial` or identity column OWNS its
 * sequence — pg_depend 'a' or 'i' from the sequence to the column — but a
 * column carrying a plain `DEFAULT nextval('…')`, which is what Movy's own
 * CREATE TABLE emits, owns nothing: its only link is a dependency from the
 * default expression. Matching the first shape alone missed exactly the tables
 * this tool creates. UNION de-duplicates serial columns, which have both.
 *
 * Ascending only: MAX() is the wrong watermark for a descending sequence.
 */
const COLUMN_SEQUENCES_SQL = `
  SELECT seq.relname AS sequence_name,
         tbl.relname AS table_name,
         att.attname AS column_name
  FROM pg_class seq
  JOIN pg_namespace ns ON ns.oid = seq.relnamespace
  JOIN pg_sequence s ON s.seqrelid = seq.oid
  JOIN pg_depend dep ON dep.classid = 'pg_class'::regclass
                    AND dep.objid = seq.oid
                    AND dep.deptype IN ('a', 'i')
  JOIN pg_class tbl ON tbl.oid = dep.refobjid
  JOIN pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = dep.refobjsubid
  WHERE seq.relkind = 'S'
    AND ns.nspname = current_schema()
    AND tbl.relnamespace = ns.oid
    AND s.seqincrement > 0

  UNION

  SELECT seq.relname AS sequence_name,
         tbl.relname AS table_name,
         att.attname AS column_name
  FROM pg_attrdef ad
  JOIN pg_depend dep ON dep.classid = 'pg_attrdef'::regclass
                    AND dep.objid = ad.oid
                    AND dep.refclassid = 'pg_class'::regclass
  JOIN pg_class seq ON seq.oid = dep.refobjid AND seq.relkind = 'S'
  JOIN pg_namespace ns ON ns.oid = seq.relnamespace
  JOIN pg_sequence s ON s.seqrelid = seq.oid
  JOIN pg_class tbl ON tbl.oid = ad.adrelid
  JOIN pg_attribute att ON att.attrelid = ad.adrelid AND att.attnum = ad.adnum
  WHERE ns.nspname = current_schema()
    AND tbl.relnamespace = ns.oid
    AND s.seqincrement > 0`;

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

    // FK constraints are intentionally excluded from the transaction below.
    // They run as best-effort after the commit so that a type mismatch between
    // referencing and referenced columns doesn't roll back all other DDL work.
    const fkAddStatements: string[] = [];
    for (const { tableName, constraint } of diff.constraintsToAdd) {
      const stmt = `ALTER TABLE ${escapeIdentifier(tableName)} ADD ${this.buildConstraintDef(constraint, tableName)};`;
      if (constraint.type === 'FOREIGN KEY') {
        fkAddStatements.push(stmt);
      } else {
        statements.push(stmt);
      }
    }

    for (const tableName of diff.tablesToDrop) {
      statements.push(`DROP TABLE IF EXISTS ${escapeIdentifier(tableName)};`);
    }

    if (statements.length > 0) {
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

    // FK additions are best-effort: the destination may have column type differences
    // that make a FK incompatible even when the data is otherwise migratable.
    for (const stmt of fkAddStatements) {
      try {
        await connection.query(stmt);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`WARN: Skipped FK constraint addition (incompatible columns): ${message}\n  Statement: ${stmt}`);
      }
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

  /**
   * A sequence that backs a column is reset from the rows that landed in the
   * DESTINATION, not from the source's `last_value` alone. A source restored by
   * a dump that copied rows without advancing its sequences hands us a counter
   * below `MAX(id)` — n8n's `workflow_publish_history_id_seq` sat at 4 against
   * ids up to 121 — and copying that verbatim reproduces the duplicate-key
   * failure on the destination instead of leaving it behind. PostgreSQL is the
   * only destination where this bites: an explicit-id INSERT never advances a
   * sequence, where InnoDB and IDENTITY_INSERT both carry their counters along.
   *
   * The source counter stays in as a FLOOR rather than being discarded. A live
   * sequence normally runs AHEAD of `MAX(id)` — every rolled-back insert burns
   * a value — and handing those ids out again on the destination would undo
   * that. So the step takes the greatest of the source counter, the rows, and
   * the sequence's own START, and can only ever move a counter forward.
   *
   * A standalone sequence backs no column, so there is no `MAX()` to read and
   * the source counter is the only value there is — those still copy across.
   */
  async resetSequences(
    source: IDatabaseConnection,
    dest: IDatabaseConnection,
    sequences: SequenceSchema[],
    tables?: TableSchema[]
  ): Promise<void> {
    const sourceCounters = await this.readSourceCounters(source, sequences);
    const resetFromData = await this.resetColumnSequences(dest, tables, sourceCounters);

    for (const seq of sequences) {
      if (resetFromData.has(seq.name)) continue;
      const counter = sourceCounters.get(seq.name);
      if (counter === undefined) continue; // unreadable on the source; already warned
      try {
        await dest.query(`SELECT setval($1, $2, true)`, [seq.name, counter.lastValue]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`WARN: Failed to reset sequence ${seq.name}: ${message}`);
      }
    }
  }

  /**
   * The source's own counter per sequence, read once. `is_called` is what makes
   * it a number rather than an ambiguity: a fresh sequence reports
   * `last_value = 1, is_called = false` and will hand out 1, while a used one
   * reporting 1 will hand out 2.
   */
  private async readSourceCounters(
    source: IDatabaseConnection,
    sequences: SequenceSchema[]
  ): Promise<Map<string, SourceCounter>> {
    const counters = new Map<string, SourceCounter>();

    for (const seq of sequences) {
      try {
        const rows = await source.query<{ last_value: string; is_called?: boolean }>(
          `SELECT last_value::text, is_called FROM ${escapeIdentifier(seq.name)}`
        );
        const row = rows[0];
        if (row?.last_value === undefined || row.last_value === null) continue;
        counters.set(seq.name, { lastValue: row.last_value, isCalled: row.is_called !== false });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`WARN: Failed to read sequence ${seq.name} from source: ${message}`);
      }
    }

    return counters;
  }

  /**
   * Advances every destination sequence that backs a migrated column past the
   * rows now in that column, and answers which ones it handled.
   *
   * Driven off the DESTINATION catalogue rather than the source's sequence
   * list: that is what makes this work for a MySQL or MSSQL source, whose
   * inspectors report no sequences at all, and for an identity column, whose
   * sequence the source may not report either. Tables outside the migration
   * set are left alone — this run did not write them.
   *
   * Returns an empty set when the catalogue read fails, so the caller falls
   * back to the source counter rather than leaving every sequence untouched.
   */
  private async resetColumnSequences(
    dest: IDatabaseConnection,
    tables?: TableSchema[],
    sourceCounters: Map<string, SourceCounter> = new Map()
  ): Promise<Set<string>> {
    const reset = new Set<string>();
    if (!tables || tables.length === 0) return reset;
    const migrated = new Set(tables.map((t) => t.name));

    let owned: RawColumnSequence[];
    try {
      owned = await dest.query<RawColumnSequence>(COLUMN_SEQUENCES_SQL);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`WARN: Failed to resolve column-backed sequences: ${message}`);
      return reset;
    }

    for (const row of owned) {
      if (!migrated.has(row.table_name)) continue;
      const table = escapeIdentifier(row.table_name);
      const column = escapeIdentifier(row.column_name);

      // is_called = false, so nextval() returns the value set. An empty table
      // falls back to the sequence's own START value.
      const bounds = [
        `COALESCE((SELECT MAX(${column}) FROM ${table}), 0) + 1`,
        `(SELECT seqstart FROM pg_sequence WHERE seqrelid = $1::regclass)`,
      ];
      const params: unknown[] = [row.sequence_name];
      const sourceFloor = nextValueOf(sourceCounters.get(row.sequence_name));
      if (sourceFloor !== undefined) {
        bounds.push(`$${params.length + 1}::bigint`);
        params.push(sourceFloor);
      }

      try {
        await dest.query(
          `SELECT setval($1::regclass, GREATEST(${bounds.join(', ')}), false)`,
          params
        );
        reset.add(row.sequence_name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `WARN: Failed to reset sequence ${row.sequence_name} from ${row.table_name}.${row.column_name}: ${message}`
        );
      }
    }

    return reset;
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
