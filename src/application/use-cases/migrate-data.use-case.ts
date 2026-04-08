import { IDataMigrator } from '../../domain/ports/data-migrator.port';
import { ILogger } from '../../domain/ports/logger.port';
import { ConnectionConfig } from '../../domain/types/connection.types';
import { MigrationResult } from '../../domain/types/migration.types';
import { formatDuration, chunkArray } from '../../shared/utils';

const MAX_WORKERS = 4;

export class MigrateDataUseCase {
  constructor(
    private readonly migrator: IDataMigrator,
    private readonly logger: ILogger
  ) {}

  async execute(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    tables: string[],
    rowEstimates: Map<string, number>
  ): Promise<MigrationResult> {
    const sorted = [...tables].sort((a, b) => {
      const aRows = rowEstimates.get(a) ?? 0;
      const bRows = rowEstimates.get(b) ?? 0;
      return bRows - aRows;
    });

    const workerCount = Math.min(MAX_WORKERS, sorted.length || 1);
    this.logger.info(`Migrating ${tables.length} tables using ${workerCount} workers...`);

    const result = await this.migrator.migrate(sourceConfig, destConfig, sorted, workerCount);

    this.printReport(result);
    return result;
  }

  private printReport(result: MigrationResult): void {
    this.logger.info('\n--- Migration Report ---');
    for (const t of result.tables) {
      const status = t.success ? 'OK' : 'FAIL';
      const rows = t.rowsCopied.toLocaleString();
      const dur = formatDuration(t.durationMs);
      this.logger.info(`  [${status}] ${t.tableName}: ${rows} rows in ${dur}${t.error ? ' — ' + t.error : ''}`);
    }
    const succeeded = result.tables.filter((t) => t.success).length;
    this.logger.info(`Total: ${succeeded}/${result.tables.length} tables succeeded in ${formatDuration(result.totalDurationMs)}`);
  }
}
