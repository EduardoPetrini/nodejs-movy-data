import type { RunMode } from './pair-capability';

/**
 * The definition and preview contracts, declared once for both halves.
 *
 * Same reasoning as `run-wire.ts`: the serializer's return type is annotated
 * with these, so a field the server stops sending becomes a type error in the
 * client rather than `undefined` in front of someone about to migrate a
 * database.
 */

export interface WireDefinitionEndpoint {
  connectionId: string;
  /** Snapshot of the connection's name at read time, for the list row. */
  connectionName: string;
  engine: string;
  /** The definition's override, or the connection's own database. */
  database: string;
  /** True when the definition pins a database rather than following the connection. */
  pinned: boolean;
}

export interface WireDefinition {
  id: string;
  name: string;
  description: string | null;
  mode: RunMode;
  source: WireDefinitionEndpoint;
  target: WireDefinitionEndpoint;
  /** Query mode only. */
  querySql: string | null;
  targetTableName: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Everything a preview found, in the order the review screen reads it.
 *
 * Warnings first in the UI, because applying is all-or-nothing with no
 * rollback: the one thing an operator must not miss is which destination
 * tables are about to be emptied.
 */
export type PreviewWarningCode =
  | 'destination_tables_emptied'
  | 'target_database_missing'
  | 'enum_degraded'
  | 'types_translated'
  | 'cyclic_foreign_keys'
  | 'destination_only_tables'
  | 'nothing_to_copy';

export interface PreviewWarning {
  code: PreviewWarningCode;
  /** `warn` is destructive or lossy; `info` is worth knowing before you commit. */
  severity: 'info' | 'warn';
  message: string;
  /** The tables or columns the message counts, so the UI can list them. */
  subjects: string[];
}

/** A column whose type the translator will change on the way across. */
export interface PreviewTypeChange {
  tableName: string;
  columnName: string;
  sourceType: string;
  targetType: string;
}

export interface PreviewTable {
  tableName: string;
  /** Absent for a table only the destination has. */
  rowsEstimated: number | null;
  /**
   * `create` — new in the destination.
   * `load`   — already there; it will be emptied and reloaded.
   * `extra`  — destination-only; Movy leaves it alone.
   */
  disposition: 'create' | 'load' | 'extra';
}

export interface PreviewDiffCounts {
  tablesToCreate: number;
  columnsToAdd: number;
  columnsToAlter: number;
  constraintsToAdd: number;
  indexesToCreate: number;
  sequencesToCreate: number;
  enumsToCreate: number;
}

export interface RunPreview {
  source: { engine: string; database: string };
  target: { engine: string; database: string };
  /** False when the destination database will be created as step 1 of the run. */
  targetDatabaseExists: boolean;
  diff: PreviewDiffCounts;
  tables: PreviewTable[];
  typeChanges: PreviewTypeChange[];
  /** Copy order from `TableMigrationPlanner`, FK parents before children. */
  loadOrder: string[];
  /** Tables in a foreign-key cycle, which the planner cannot order. */
  cyclicTables: string[];
  totalRowsEstimated: number;
  warnings: PreviewWarning[];
  /** When the preview ran. A preview is a snapshot, not a promise. */
  takenAt: string;
}
