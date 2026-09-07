import { IDataMigrator } from '../../domain/ports/data-migrator.port.js';
import { ILogger } from '../../domain/ports/logger.port.js';
import { ConnectionConfig, DatabaseType } from '../../domain/types/connection.types.js';
import { MigrationResult, TableMigrationResult } from '../../domain/types/migration.types.js';
import { TableSchema } from '../../domain/types/schema.types.js';
import { formatDuration } from '../../shared/utils.js';
import { TableMigrationPlanner } from '../services/table-migration-planner.service.js';
import { MigrationRunContext } from '../../domain/ports/event-sink.port.js';

const MAX_WORKERS = 4;

export class MigrateDataUseCase {
  private readonly planner: TableMigrationPlanner;

  constructor(
    private readonly migrator: IDataMigrator,
    private readonly logger: ILogger,
    planner?: TableMigrationPlanner
  ) {
    this.planner = planner ?? new TableMigrationPlanner();
  }

  async execute(
    sourceConfig: ConnectionConfig,
    destConfig: ConnectionConfig,
    tables: TableSchema[],
    rowEstimates: Map<string, number>,
    ctx?: MigrationRunContext
  ): Promise<MigrationResult> {
    const plan = this.planner.plan(tables, rowEstimates);

    this.printMigrationPlan(plan.loadOrder, rowEstimates);
    if (plan.cyclicTables.length > 0) {
      this.logger.warn(
        `Detected cyclic/self-referencing foreign key dependencies: ${plan.cyclicTables.join(', ')}. ` +
          'Ordering will be best-effort and MySQL destination sessions must disable FK checks during copy.'
      );
    }

    const workerCount =
      sourceConfig.type === DatabaseType.POSTGRES && destConfig.type === DatabaseType.POSTGRES
        ? Math.min(MAX_WORKERS, plan.loadOrder.length || 1)
        : 1;
    const workerLabel = workerCount === 1 ? 'worker' : 'workers';
    this.logger.info(`Starting migration with ${workerCount} ${workerLabel}...`);

    ctx?.emit({
      type: 'plan_ready',
      plan,
      // Map is not JSON-serialisable and this crosses IPC and socket boundaries.
      rowEstimates: Object.fromEntries(rowEstimates),
      workerCount,
    });

    const rowsDoneByTable = new Map<string, number>();
    const completedTables = new Map<string, number>(); // tableName -> actual rows copied
    const tableStartedAt = new Map<string, number>();
    const emittedFinished = new Set<string>();

    const result = await this.migrator.migrate(
      sourceConfig,
      destConfig,
      plan,
      workerCount,
      rowEstimates,
      (tableName, rowsDone, rowsTotal) => {
        if (!tableStartedAt.has(tableName)) tableStartedAt.set(tableName, Date.now());
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
        const inProgressTotal = plan.loadOrder
          .filter((t) => rowsDoneByTable.has(t))
          .reduce((s, t) => s + Math.max(rowEstimates.get(t) ?? 0, rowsDoneByTable.get(t) ?? 0), 0);
        const pendingEstimate = plan.loadOrder
          .filter((t) => !completedTables.has(t) && !rowsDoneByTable.has(t))
          .reduce((s, t) => s + (rowEstimates.get(t) ?? 0), 0);
        const overallTotal = completedActual + inProgressTotal + pendingEstimate;

        const overallPctValue =
          overallTotal > 0 ? Math.min(100, (overallDone / overallTotal) * 100) : 0;
        const overallPct = overallTotal > 0 ? overallPctValue.toFixed(1) : '?';

        if (isCompletion) {
          // Emitted as it happens so a long run's timeline stays live; the
          // authoritative duration is whatever the migrator reports, but that
          // only arrives once every table is done.
          emittedFinished.add(tableName);
          ctx?.emit({
            type: 'table_finished',
            tableName,
            rowsCopied: rowsDone,
            durationMs: Date.now() - (tableStartedAt.get(tableName) ?? Date.now()),
            success: true,
          });
        } else {
          ctx?.emit({ type: 'table_progress', tableName, rowsDone, rowsTotal, pct });
          this.logger.info(
            `  [${tableName}] ${rowsDone.toLocaleString()} / ~${rowsTotal.toLocaleString()} rows  ${pct}%  (overall: ${overallPct}%)`
          );
        }

        ctx?.emit({
          type: 'overall_progress',
          rowsDone: overallDone,
          rowsTotal: overallTotal,
          pct: overallPctValue,
          tablesDone: completedTables.size,
          tablesTotal: plan.loadOrder.length,
        });
      }
    );

    for (const table of result.tables) {
      if (emittedFinished.has(table.tableName)) continue;
      ctx?.emit({
        type: 'table_finished',
        tableName: table.tableName,
        rowsCopied: table.rowsCopied,
        durationMs: table.durationMs,
        success: table.success,
        error: table.error,
      });
    }

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
