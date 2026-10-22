import { ConnectionConfig } from '../types/connection.types.js';
import { MigrationResult, TableMigrationPlan } from '../types/migration.types.js';

export type MigrationProgressCallback = (tableName: string, rowsDone: number, rowsTotal: number) => void;

export interface IDataMigrator {
  /**
   * `signal` is optional and trailing for the same reason `ctx` is on the
   * orchestrator: it had to be addable without touching five adapters' call
   * sites and every mock in the suite at once.
   *
   * Honouring it means stopping between tables, and between batches within a
   * table, and terminating any worker threads. It does NOT mean interrupting a
   * statement already in flight — a running COPY or CREATE INDEX cannot be cut
   * short from Node without per-driver support — so a cancelled run finishes
   * the batch it is on and then stops. Nothing is rolled back.
   */
  migrate(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    plan: TableMigrationPlan,
    workerCount: number,
    rowEstimates?: Map<string, number>,
    onProgress?: MigrationProgressCallback,
    signal?: AbortSignal
  ): Promise<MigrationResult>;
}
