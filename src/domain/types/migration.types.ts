import { TableSchema, SequenceSchema, ConstraintSchema, IndexSchema, EnumSchema } from './schema.types';

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
  constraintsToAdd: { tableName: string; constraint: ConstraintSchema; columnTypes?: Record<string, string> }[];
  constraintsToDrop: { tableName: string; constraintName: string; constraintType: 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY' | 'CHECK' }[];
  indexesToCreate: { tableName: string; index: IndexSchema }[];
  indexesToDrop: { tableName: string; indexName: string }[];
  sequencesToCreate: SequenceSchema[];
  enumsToCreate: EnumSchema[];
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

export interface TableMigrationPlan {
  loadOrder: string[];
  cleanupOrder: string[];
  levels: string[][];
  cyclicTables: string[];
}
