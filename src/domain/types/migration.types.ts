import { TableSchema, SequenceSchema, ConstraintSchema, IndexSchema } from './schema.types';

export interface ColumnDiff {
  columnName: string;
  sourceType: string;
  targetType: string;
}

export interface SchemaDiff {
  tablesToCreate: TableSchema[];
  tablesToDrop: string[];
  columnsToAdd: { tableName: string; column: import('./schema.types').ColumnSchema }[];
  columnsToDrop: { tableName: string; columnName: string }[];
  columnsToAlter: { tableName: string; diff: ColumnDiff }[];
  constraintsToAdd: { tableName: string; constraint: ConstraintSchema }[];
  constraintsToDrop: { tableName: string; constraintName: string }[];
  indexesToCreate: { tableName: string; index: IndexSchema }[];
  indexesToDrop: { tableName: string; indexName: string }[];
  sequencesToCreate: SequenceSchema[];
}

export interface TableMigrationResult {
  tableName: string;
  rowsCopied: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface MigrationResult {
  tables: TableMigrationResult[];
  totalDurationMs: number;
  success: boolean;
}
