import { ConnectionConfig } from '../types/connection.types';
import { MigrationResult, TableMigrationPlan } from '../types/migration.types';

export type MigrationProgressCallback = (tableName: string, rowsDone: number, rowsTotal: number) => void;

export interface IDataMigrator {
  migrate(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    plan: TableMigrationPlan,
    workerCount: number,
    rowEstimates?: Map<string, number>,
    onProgress?: MigrationProgressCallback
  ): Promise<MigrationResult>;
}
