import { ConnectionConfig } from '../types/connection.types';
import { MigrationResult } from '../types/migration.types';

export interface IDataMigrator {
  migrate(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    tables: string[],
    workerCount: number
  ): Promise<MigrationResult>;
}
