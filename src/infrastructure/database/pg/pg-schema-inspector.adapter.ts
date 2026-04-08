import { ISchemaInspector } from '../../../domain/ports/schema-inspector.port';
import { IDatabaseConnection } from '../../../domain/ports/database.port';
import {
  DatabaseSchema,
  TableSchema,
  ColumnSchema,
  ConstraintSchema,
  IndexSchema,
  SequenceSchema,
} from '../../../domain/types/schema.types';
import { SchemaInspectionError } from '../../../domain/errors/migration.errors';

interface RawColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
}

interface RawConstraint {
  table_name: string;
  constraint_name: string;
  constraint_type: string;
  column_name: string;
  foreign_table_name: string | null;
  foreign_column_name: string | null;
  delete_rule: string | null;
  update_rule: string | null;
  check_clause: string | null;
}

interface RawIndex {
  table_name: string;
  index_name: string;
  column_name: string;
  is_unique: boolean;
  index_method: string;
}

interface RawSequence {
  sequence_name: string;
  start_value: string;
  minimum_value: string;
  maximum_value: string;
  increment: string;
  cycle_option: string;
}

interface RawRowEstimate {
  relname: string;
  reltuples: number;
}

export class PgSchemaInspector implements ISchemaInspector {
  async inspect(
    connection: IDatabaseConnection,
    schemaName = 'public'
  ): Promise<DatabaseSchema> {
    try {
      const [columns, constraints, indexes, sequences] = await Promise.all([
        this.fetchColumns(connection, schemaName),
        this.fetchConstraints(connection, schemaName),
        this.fetchIndexes(connection, schemaName),
        this.fetchSequences(connection, schemaName),
      ]);

      const tables = this.buildTables(columns, constraints, indexes);
      return { tables, sequences };
    } catch (err) {
      if (err instanceof SchemaInspectionError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new SchemaInspectionError(`Schema inspection failed: ${message}`);
    }
  }

  async getTableRowEstimates(
    connection: IDatabaseConnection
  ): Promise<Map<string, number>> {
    const rows = await connection.query<RawRowEstimate>(
      `SELECT relname, reltuples::bigint AS reltuples
       FROM pg_class
       WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace`
    );
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.relname, Math.max(0, row.reltuples));
    }
    return map;
  }

  private async fetchColumns(
    connection: IDatabaseConnection,
    schemaName: string
  ): Promise<RawColumn[]> {
    return connection.query<RawColumn>(
      `SELECT
         c.table_name,
         c.column_name,
         c.data_type,
         c.udt_name,
         c.is_nullable,
         c.column_default,
         c.character_maximum_length,
         c.numeric_precision,
         c.numeric_scale
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON c.table_name = t.table_name
        AND c.table_schema = t.table_schema
       WHERE c.table_schema = $1
         AND t.table_type = 'BASE TABLE'
       ORDER BY c.table_name, c.ordinal_position`,
      [schemaName]
    );
  }

  private async fetchConstraints(
    connection: IDatabaseConnection,
    schemaName: string
  ): Promise<RawConstraint[]> {
    return connection.query<RawConstraint>(
      `SELECT
         tc.table_name,
         tc.constraint_name,
         tc.constraint_type,
         kcu.column_name,
         ccu.table_name AS foreign_table_name,
         ccu.column_name AS foreign_column_name,
         rc.delete_rule,
         rc.update_rule,
         cc.check_clause
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       LEFT JOIN information_schema.referential_constraints rc
         ON tc.constraint_name = rc.constraint_name
        AND tc.table_schema = rc.constraint_schema
       LEFT JOIN information_schema.constraint_column_usage ccu
         ON rc.unique_constraint_name = ccu.constraint_name
        AND rc.unique_constraint_schema = ccu.table_schema
       LEFT JOIN information_schema.check_constraints cc
         ON tc.constraint_name = cc.constraint_name
        AND tc.table_schema = cc.constraint_schema
       WHERE tc.table_schema = $1
         AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY', 'CHECK')
       ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position`,
      [schemaName]
    );
  }

  private async fetchIndexes(
    connection: IDatabaseConnection,
    schemaName: string
  ): Promise<RawIndex[]> {
    return connection.query<RawIndex>(
      `SELECT
         t.relname AS table_name,
         i.relname AS index_name,
         a.attname AS column_name,
         ix.indisunique AS is_unique,
         am.amname AS index_method
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_am am ON am.oid = i.relam
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
       WHERE n.nspname = $1
         AND t.relkind = 'r'
         AND NOT ix.indisprimary
       ORDER BY t.relname, i.relname, a.attnum`,
      [schemaName]
    );
  }

  private async fetchSequences(
    connection: IDatabaseConnection,
    schemaName: string
  ): Promise<SequenceSchema[]> {
    const rows = await connection.query<RawSequence>(
      `SELECT
         sequence_name,
         start_value,
         minimum_value,
         maximum_value,
         increment,
         cycle_option
       FROM information_schema.sequences
       WHERE sequence_schema = $1
       ORDER BY sequence_name`,
      [schemaName]
    );

    const sequences: SequenceSchema[] = [];
    for (const row of rows) {
      let lastValue: number | null = null;
      try {
        const lastRows = await connection.query<{ last_value: number }>(
          `SELECT last_value FROM "${schemaName}"."${row.sequence_name}"`
        );
        lastValue = lastRows[0]?.last_value ?? null;
      } catch {
        // sequence may not have been used yet
      }

      sequences.push({
        name: row.sequence_name,
        startValue: parseInt(row.start_value, 10),
        minValue: parseInt(row.minimum_value, 10),
        maxValue: parseInt(row.maximum_value, 10),
        incrementBy: parseInt(row.increment, 10),
        cycleOption: row.cycle_option === 'YES',
        lastValue,
      });
    }

    return sequences;
  }

  private buildTables(
    columns: RawColumn[],
    constraints: RawConstraint[],
    indexes: RawIndex[]
  ): TableSchema[] {
    const tableNames = [...new Set(columns.map((c) => c.table_name))];

    return tableNames.map((tableName) => {
      const tableColumns: ColumnSchema[] = columns
        .filter((c) => c.table_name === tableName)
        .map((c) => ({
          name: c.column_name,
          dataType: c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type,
          isNullable: c.is_nullable === 'YES',
          defaultValue: c.column_default,
          characterMaxLength: c.character_maximum_length,
          numericPrecision: c.numeric_precision,
          numericScale: c.numeric_scale,
        }));

      const tableConstraints = this.buildConstraints(
        constraints.filter((c) => c.table_name === tableName)
      );

      const tableIndexes = this.buildIndexes(
        indexes.filter((i) => i.table_name === tableName)
      );

      return { name: tableName, columns: tableColumns, constraints: tableConstraints, indexes: tableIndexes };
    });
  }

  private buildConstraints(rows: RawConstraint[]): ConstraintSchema[] {
    const constraintMap = new Map<string, ConstraintSchema>();

    for (const row of rows) {
      if (constraintMap.has(row.constraint_name)) {
        constraintMap.get(row.constraint_name)!.columns.push(row.column_name);
      } else {
        const base: ConstraintSchema = {
          name: row.constraint_name,
          type: row.constraint_type as ConstraintSchema['type'],
          columns: [row.column_name],
        };

        if (row.constraint_type === 'FOREIGN KEY') {
          base.referencedTable = row.foreign_table_name ?? undefined;
          base.referencedColumns = row.foreign_column_name ? [row.foreign_column_name] : [];
          base.onDelete = row.delete_rule ?? undefined;
          base.onUpdate = row.update_rule ?? undefined;
        }

        if (row.constraint_type === 'CHECK' && row.check_clause) {
          base.checkExpression = row.check_clause;
        }

        constraintMap.set(row.constraint_name, base);
      }
    }

    return Array.from(constraintMap.values());
  }

  private buildIndexes(rows: RawIndex[]): IndexSchema[] {
    const indexMap = new Map<string, IndexSchema>();

    for (const row of rows) {
      if (indexMap.has(row.index_name)) {
        indexMap.get(row.index_name)!.columns.push(row.column_name);
      } else {
        indexMap.set(row.index_name, {
          name: row.index_name,
          columns: [row.column_name],
          isUnique: row.is_unique,
          method: row.index_method,
        });
      }
    }

    return Array.from(indexMap.values());
  }
}
