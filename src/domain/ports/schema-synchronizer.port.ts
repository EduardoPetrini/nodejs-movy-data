import { IDatabaseConnection } from './database.port';
import { DatabaseSchema, SequenceSchema, TableSchema } from '../types/schema.types';
import { SchemaDiff } from '../types/migration.types';

export interface ISchemaSynchronizer {
  diff(source: DatabaseSchema, target: DatabaseSchema): SchemaDiff;
  apply(connection: IDatabaseConnection, diff: SchemaDiff): Promise<void>;
  disableTriggers(connection: IDatabaseConnection, tables: string[]): Promise<void>;
  enableTriggers(connection: IDatabaseConnection, tables: string[]): Promise<void>;
  createIndexes(connection: IDatabaseConnection, diff: SchemaDiff): Promise<void>;
  /**
   * Reset auto-increment state on the destination to match the source.
   * PostgreSQL uses `sequences` (SequenceSchema). MySQL uses per-table
   * `AUTO_INCREMENT` counters, read from `tables`.
   */
  resetSequences(
    source: IDatabaseConnection,
    dest: IDatabaseConnection,
    sequences: SequenceSchema[],
    tables?: TableSchema[]
  ): Promise<void>;
}
