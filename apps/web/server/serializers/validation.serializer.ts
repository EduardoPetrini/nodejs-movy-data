import type { ValidationListRow, ValidationTableRow } from '../repositories/validations.repo';
import type { WireTableCount, WireValidation, WireValidationDetail } from '../../shared/validation-wire';

/**
 * What a client is allowed to see of a comparison.
 *
 * Built up, never torn down — the same rule as the run and connection
 * serializers. There is no role split here, deliberately: a comparison carries
 * engine, database and two counts, which is what a viewer is FOR. The
 * connection ids are not copied at all, so there is nothing to gate.
 *
 * Declared in `shared/validation-wire.ts`, so a field this stops sending is a
 * type error in the compare page rather than `undefined` in front of someone
 * reading counts.
 */
export function toPublicValidation(row: ValidationListRow): WireValidation {
  const v = row.validation;
  return {
    id: v.id,
    status: v.status,
    source: { engine: v.sourceEngine, database: v.sourceDatabase },
    target: { engine: v.targetEngine, database: v.targetDatabase },
    totalSource: v.totalSource,
    totalDest: v.totalDest,
    totalMatchPct: v.totalMatchPct,
    allMatch: v.allMatch,
    tablesCompared: v.tablesCompared,
    tablesMismatched: v.tablesMismatched,
    error: v.errorMessage ? { name: v.errorName ?? 'Error', message: v.errorMessage } : null,
    runId: v.runId,
    definitionId: v.definitionId,
    definitionName: row.definitionName,
    startedAt: v.startedAt.toISOString(),
    finishedAt: v.finishedAt?.toISOString() ?? null,
    durationMs: v.durationMs,
    createdAt: v.createdAt.toISOString(),
  };
}

export function toPublicTableCount(row: ValidationTableRow): WireTableCount {
  return {
    tableName: row.tableName,
    sourceCount: row.sourceCount,
    destCount: row.destCount,
    matchPct: row.matchPct,
  };
}

export function toPublicValidationDetail(
  row: ValidationListRow,
  tables: readonly ValidationTableRow[]
): WireValidationDetail {
  return { ...toPublicValidation(row), tables: tables.map(toPublicTableCount) };
}
