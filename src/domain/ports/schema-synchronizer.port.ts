import { IDatabaseConnection } from './database.port';
import { DatabaseSchema, SequenceSchema } from '../types/schema.types';
import { SchemaDiff } from '../types/migration.types';

export interface ISchemaSynchronizer {
  diff(source: DatabaseSchema, target: DatabaseSchema): SchemaDiff;
  apply(connection: IDatabaseConnection, diff: SchemaDiff): Promise<void>;
  disableTriggers(connection: IDatabaseConnection, tables: string[]): Promise<void>;
  enableTriggers(connection: IDatabaseConnection, tables: string[]): Promise<void>;
  createIndexes(connection: IDatabaseConnection, diff: SchemaDiff): Promise<void>;
  resetSequences(
    source: IDatabaseConnection,
    dest: IDatabaseConnection,
    sequences: SequenceSchema[]
  ): Promise<void>;
}
