import { IDataMigrator } from '../../domain/ports/data-migrator.port';
import { ILogger } from '../../domain/ports/logger.port';
import { ConnectionConfig } from '../../domain/types/connection.types';
import { MigrationResult, TableMigrationResult } from '../../domain/types/migration.types';
import { formatDuration } from '../../shared/utils';

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
      return (rowEstimates.get(b) ?? 0) - (rowEstimates.get(a) ?? 0);
    });

    this.printMigrationPlan(sorted, rowEstimates);

    const workerCount = Math.min(MAX_WORKERS, sorted.length || 1);
    this.logger.info(`Starting migration with ${workerCount} parallel worker(s)...`);

    const rowsDoneByTable = new Map<string, number>();
    const completedTables = new Map<string, number>(); // tableName -> actual rows copied

    const result = await this.migrator.migrate(
      sourceConfig,
      destConfig,
      sorted,
      workerCount,
      rowEstimates,
      (tableName, rowsDone, rowsTotal) => {
        // Completion signal: worker-pool sends (actual, actual) on table_done
        const isCompletion = rowsTotal > 0 && rowsDone === rowsTotal;
        if (isCompletion) {
          completedTables.set(tableName, rowsDone);
          rowsDoneByTable.delete(tableName);
        } else {
          rowsDoneByTable.set(tableName, rowsDone);
        }

        const pct =
          rowsTotal > 0 ? Math.min(100, Math.round((rowsDone / rowsTotal) * 100)) : 0;

        // Overall numerator: actual rows for completed + current progress for in-progress
        const completedActual = [...completedTables.values()].reduce((s, v) => s + v, 0);
        const inProgressDone = [...rowsDoneByTable.values()].reduce((s, v) => s + v, 0);
        const overallDone = completedActual + inProgressDone;

        // Overall denominator: actual for completed + max(estimate, actual) for in-progress + estimate for not-yet-started
        const inProgressTotal = sorted
          .filter((t) => rowsDoneByTable.has(t))
          .reduce((s, t) => s + Math.max(rowEstimates.get(t) ?? 0, rowsDoneByTable.get(t) ?? 0), 0);
        const pendingEstimate = sorted
          .filter((t) => !completedTables.has(t) && !rowsDoneByTable.has(t))
          .reduce((s, t) => s + (rowEstimates.get(t) ?? 0), 0);
        const overallTotal = completedActual + inProgressTotal + pendingEstimate;

        const overallPct =
          overallTotal > 0
            ? Math.min(100, (overallDone / overallTotal) * 100).toFixed(1)
            : '?';

        if (!isCompletion) {
          this.logger.info(
            `  [${tableName}] ${rowsDone.toLocaleString()} / ~${rowsTotal.toLocaleString()} rows  ${pct}%  (overall: ${overallPct}%)`
          );
        }
      }
    );

    this.printReport(result, rowEstimates);
    return result;
  }

  private printMigrationPlan(tables: string[], rowEstimates: Map<string, number>): void {
    const totalEstimated = tables.reduce((sum, t) => sum + (rowEstimates.get(t) ?? 0), 0);
    this.logger.info(
      `\nTables to migrate (${tables.length} table${tables.length !== 1 ? 's' : ''}, ~${totalEstimated.toLocaleString()} estimated rows):`
    );

    const maxNameLen = Math.max(...tables.map((t) => t.length), 5);
    for (const table of tables) {
      const est = rowEstimates.get(table) ?? 0;
      const rowsStr = `~${est.toLocaleString()} rows`;
      this.logger.info(`  ${table.padEnd(maxNameLen + 2)} ${rowsStr}`);
    }
    this.logger.info('');
  }

  private printReport(result: MigrationResult, rowEstimates: Map<string, number>): void {
    const colWidths = this.calcColumnWidths(result.tables);
    const totalRows = result.tables.reduce((s, t) => s + t.rowsCopied, 0);
    const succeeded = result.tables.filter((t) => t.success).length;

    const sep = (l: string, m: string, r: string, fill: string) =>
      l +
      fill.repeat(colWidths.name + 2) +
      m +
      fill.repeat(colWidths.status + 2) +
      m +
      fill.repeat(colWidths.rows + 2) +
      m +
      fill.repeat(colWidths.duration + 2) +
      r;

    const row = (name: string, status: string, rows: string, duration: string) =>
      '| ' +
      name.padEnd(colWidths.name) +
      ' | ' +
      status.padEnd(colWidths.status) +
      ' | ' +
      rows.padStart(colWidths.rows) +
      ' | ' +
      duration.padStart(colWidths.duration) +
      ' |';

    this.logger.info('');
    this.logger.info(sep('+', '+', '+', '-'));
    this.logger.info(row('Table', 'Status', 'Rows', 'Duration'));
    this.logger.info(sep('+', '+', '+', '-'));

    for (const t of result.tables) {
      const status = t.success ? 'OK' : 'FAIL';
      const rows = t.rowsCopied.toLocaleString();
      const dur = formatDuration(t.durationMs);
      const name = t.error ? `${t.tableName} (${t.error})` : t.tableName;
      this.logger.info(row(name, status, rows, dur));
    }

    this.logger.info(sep('+', '+', '+', '-'));
    this.logger.info(
      row(
        `TOTAL (${succeeded}/${result.tables.length} tables)`,
        succeeded === result.tables.length ? 'OK' : 'PARTIAL',
        totalRows.toLocaleString(),
        formatDuration(result.totalDurationMs)
      )
    );
    this.logger.info(sep('+', '+', '+', '-'));
    this.logger.info('');
  }

  private calcColumnWidths(tables: TableMigrationResult[]): {
    name: number;
    status: number;
    rows: number;
    duration: number;
  } {
    const totalRows = tables.reduce((s, t) => s + t.rowsCopied, 0);
    const succeeded = tables.filter((t) => t.success).length;

    const nameLen = Math.max(
      'Table'.length,
      `TOTAL (${succeeded}/${tables.length} tables)`.length,
      ...tables.map((t) => (t.error ? `${t.tableName} (${t.error})` : t.tableName).length)
    );

    const rowsLen = Math.max(
      'Rows'.length,
      totalRows.toLocaleString().length,
      ...tables.map((t) => t.rowsCopied.toLocaleString().length)
    );

    const durLen = Math.max(
      'Duration'.length,
      formatDuration(tables.reduce((s, t) => Math.max(s, t.durationMs), 0)).length,
      ...tables.map((t) => formatDuration(t.durationMs).length)
    );

    return { name: nameLen, status: 'PARTIAL'.length, rows: rowsLen, duration: durLen };
  }
}
