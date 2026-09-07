import { ISchemaSynchronizer } from '../../../domain/ports/schema-synchronizer.port.js';
import { IDatabaseConnection } from '../../../domain/ports/database.port.js';
import {
  DatabaseSchema,
  TableSchema,
  ColumnSchema,
  ConstraintSchema,
  SequenceSchema,
} from '../../../domain/types/schema.types.js';
import { SchemaDiff } from '../../../domain/types/migration.types.js';
import { SchemaSyncError } from '../../../domain/errors/migration.errors.js';

function escapeId(name: string): string {
  return '[' + name.replace(/]/g, ']]') + ']';
}

export class MssqlSchemaSynchronizer implements ISchemaSynchronizer {
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
        const columnTypes: Record<string, string> = Object.fromEntries(
          sourceTable.columns.map((c) => [c.name, c.dataType])
        );
        for (const constraint of sourceTable.constraints) {
          if (constraint.type === 'FOREIGN KEY') {
            constraintsToAdd.push({ tableName: sourceTable.name, constraint, columnTypes });
          }
        }
        for (const index of sourceTable.indexes) {
          indexesToCreate.push({ tableName: sourceTable.name, index });
        }
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
      sequencesToCreate: [],
      enumsToCreate: [],
    };
  }

  async apply(connection: IDatabaseConnection, diff: SchemaDiff): Promise<void> {
    const mainStatements: string[] = [];
    const fkStatements: string[] = [];

    for (const table of diff.tablesToCreate) {
      mainStatements.push(this.buildCreateTable(table));
    }

    for (const { tableName, constraintName, constraintType } of diff.constraintsToDrop) {
      if (constraintType === 'FOREIGN KEY') {
        mainStatements.push(
          `ALTER TABLE ${escapeId(tableName)} DROP CONSTRAINT ${escapeId(constraintName)};`
        );
      } else {
        mainStatements.push(
          `ALTER TABLE ${escapeId(tableName)} DROP CONSTRAINT ${escapeId(constraintName)};`
        );
      }
    }

    for (const { tableName, indexName } of diff.indexesToDrop) {
      mainStatements.push(
        `DROP INDEX ${escapeId(indexName)} ON ${escapeId(tableName)};`
      );
    }

    for (const { tableName, columnName } of diff.columnsToDrop) {
      mainStatements.push(
        `ALTER TABLE ${escapeId(tableName)} DROP COLUMN ${escapeId(columnName)};`
      );
    }

    for (const { tableName, column } of diff.columnsToAdd) {
      mainStatements.push(
        `ALTER TABLE ${escapeId(tableName)} ADD ${this.buildColumnDef(column)};`
      );
    }

    for (const { tableName, diff: colDiff } of diff.columnsToAlter) {
      mainStatements.push(
        `ALTER TABLE ${escapeId(tableName)} ALTER COLUMN ${escapeId(colDiff.columnName)} ${colDiff.sourceType};`
      );
    }

    for (const { tableName, constraint, columnTypes } of diff.constraintsToAdd) {
      const colTypeMap = columnTypes ? new Map(Object.entries(columnTypes)) : new Map<string, string>();
      const def = this.buildConstraintDef(constraint, colTypeMap);
      if (!def) continue;
      if (constraint.type === 'FOREIGN KEY') {
        fkStatements.push(`ALTER TABLE ${escapeId(tableName)} ADD ${def};`);
      } else {
        mainStatements.push(`ALTER TABLE ${escapeId(tableName)} ADD ${def};`);
      }
    }

    for (const tableName of diff.tablesToDrop) {
      mainStatements.push(
        `IF OBJECT_ID(N'${tableName.replace(/'/g, "''")}', N'U') IS NOT NULL DROP TABLE ${escapeId(tableName)};`
      );
    }

    for (const stmt of mainStatements) {
      try {
        await connection.query(stmt);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new SchemaSyncError(`Schema sync failed on statement:\n${stmt}\n\nError: ${message}`);
      }
    }

    for (const stmt of fkStatements) {
      try {
        await connection.query(stmt);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`WARN: Skipped FK constraint addition: ${message}\n  Statement: ${stmt}`);
      }
    }
  }

  async disableTriggers(connection: IDatabaseConnection, tables: string[]): Promise<void> {
    for (const table of tables) {
      await connection.query(`ALTER TABLE ${escapeId(table)} NOCHECK CONSTRAINT ALL`);
    }
  }

  async enableTriggers(connection: IDatabaseConnection, tables: string[]): Promise<void> {
    for (const table of tables) {
      await connection.query(`ALTER TABLE ${escapeId(table)} WITH CHECK CHECK CONSTRAINT ALL`);
    }
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
        // eslint-disable-next-line no-console
        console.warn(`WARN: Failed to create index ${index.name}: ${message}`);
      }
    }
  }

  async resetSequences(
    source: IDatabaseConnection,
    dest: IDatabaseConnection,
    _sequences: SequenceSchema[],
    tables: TableSchema[] = []
  ): Promise<void> {
    for (const table of tables) {
      // MSSQL allows one IDENTITY column per table, so the first match is the one.
      const identityColumn = table.columns.find((c) => c.autoIncrement);
      if (!identityColumn) continue;

      try {
        const rows = await source.query<{ max_id: number | null }>(
          `SELECT MAX(${escapeId(identityColumn.name)}) AS max_id FROM ${escapeId(table.name)}`
        );
        const maxId = rows[0]?.max_id;
        if (maxId == null || maxId <= 0) continue;

        await dest.query(`DBCC CHECKIDENT ('${table.name.replace(/'/g, "''")}', RESEED, ${maxId})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`WARN: Failed to reseed IDENTITY for ${table.name}: ${message}`);
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
    const columnTypes: Record<string, string> = Object.fromEntries(
      source.columns.map((c) => [c.name, c.dataType])
    );

    for (const constraint of source.constraints) {
      if (!targetConstraints.has(constraint.name)) {
        toAdd.push({ tableName: source.name, constraint, columnTypes });
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
      `IF OBJECT_ID(N'${table.name.replace(/'/g, "''")}', N'U') IS NULL\n` +
      `CREATE TABLE ${escapeId(table.name)} (\n${lines.join(',\n')}\n);`
    );
  }

  private buildColumnDef(col: ColumnSchema): string {
    let def = `${escapeId(col.name)} ${col.dataType}`;
    if (!col.isNullable) def += ' NOT NULL';
    if (col.autoIncrement) def += ' IDENTITY(1,1)';
    if (col.defaultValue !== null && !col.autoIncrement) {
      def += ` DEFAULT ${col.defaultValue}`;
    }
    return def;
  }

  private buildConstraintDef(
    constraint: ConstraintSchema,
    _colTypeMap: Map<string, string> = new Map()
  ): string | null {
    const name = escapeId(constraint.name);
    const cols = constraint.columns.map(escapeId).join(', ');

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
        return `CONSTRAINT ${name} CHECK (${constraint.checkExpression})`;
      default:
        return null;
    }
  }
}
