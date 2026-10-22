import { describe, it, expect } from 'vitest';
import type { ValidationRow, ValidationTableRow } from '../../server/repositories/validations.repo';
import {
  toPublicValidation,
  toPublicValidationDetail,
} from '../../server/serializers/validation.serializer';

const row: ValidationRow = {
  id: 'val-1',
  orgId: 'org-1',
  runId: 'run-1',
  definitionId: 'def-1',
  sourceConnectionId: 'conn-src',
  targetConnectionId: 'conn-dst',
  sourceEngine: 'postgres',
  sourceDatabase: 'movy_fixture_src',
  targetEngine: 'postgres',
  targetDatabase: 'movy_fixture_dst',
  status: 'succeeded',
  totalSource: 315_000,
  totalDest: 314_500,
  totalMatchPct: 99.841,
  allMatch: false,
  tablesCompared: 5,
  tablesMismatched: 1,
  errorName: null,
  errorMessage: null,
  requestedByUserId: 'user-1',
  startedAt: new Date('2026-09-08T10:00:00.000Z'),
  finishedAt: new Date('2026-09-08T10:00:04.000Z'),
  durationMs: 4000,
  createdAt: new Date('2026-09-08T10:00:00.000Z'),
};

const listRow = { validation: row, definitionName: 'Nightly reporting' };

describe('toPublicValidation', () => {
  it('never copies the connection ids', () => {
    // Built up, never torn down. A comparison is readable by a viewer, and a
    // connection id is the handle to credential metadata they must not get.
    const wire = toPublicValidation(listRow) as Record<string, unknown>;
    expect(wire.sourceConnectionId).toBeUndefined();
    expect(wire.targetConnectionId).toBeUndefined();
  });

  it('never copies the org id or the requester', () => {
    const wire = toPublicValidation(listRow) as Record<string, unknown>;
    expect(wire.orgId).toBeUndefined();
    expect(wire.requestedByUserId).toBeUndefined();
  });

  it('carries engine and database only, the same pair a run event carries', () => {
    const wire = toPublicValidation(listRow);
    expect(wire.source).toEqual({ engine: 'postgres', database: 'movy_fixture_src' });
    expect(Object.keys(wire.target)).toEqual(['engine', 'database']);
  });

  it('sends the stored match percentage, not one recomputed from the totals', () => {
    // ValidateCountsUseCase clamps at 100; recomputing here would disagree with
    // the number the comparison actually reported whenever the destination has
    // more rows than the source.
    expect(toPublicValidation(listRow).totalMatchPct).toBe(99.841);
  });

  it('takes the definition name from the join, and tolerates its absence', () => {
    expect(toPublicValidation(listRow).definitionName).toBe('Nightly reporting');
    expect(toPublicValidation({ validation: row, definitionName: null }).definitionName).toBeNull();
  });

  it('reports an error as a name/message pair only when there is a message', () => {
    expect(toPublicValidation(listRow).error).toBeNull();
    const failed = toPublicValidation({
      validation: { ...row, status: 'failed', errorName: null, errorMessage: 'connect ECONNREFUSED' },
      definitionName: null,
    });
    // A missing name still yields a usable pair rather than a null the page
    // would have to branch on.
    expect(failed.error).toEqual({ name: 'Error', message: 'connect ECONNREFUSED' });
  });

  it('serialises every date as ISO, so the client parses one format', () => {
    const wire = toPublicValidation(listRow);
    expect(wire.createdAt).toBe('2026-09-08T10:00:00.000Z');
    expect(wire.finishedAt).toBe('2026-09-08T10:00:04.000Z');
  });

  it('reports a comparison still running as having no finish', () => {
    const running = toPublicValidation({
      validation: { ...row, status: 'running', finishedAt: null, durationMs: null },
      definitionName: null,
    });
    expect(running.finishedAt).toBeNull();
    expect(running.durationMs).toBeNull();
  });
});

describe('toPublicValidationDetail', () => {
  const tables: ValidationTableRow[] = [
    { validationRunId: 'val-1', tableName: 'customers', sourceCount: 1000, destCount: 1000, matchPct: 100 },
    { validationRunId: 'val-1', tableName: 'order_items', sourceCount: 200_000, destCount: 199_500, matchPct: 99.75 },
  ];

  it('adds the per-table counts and drops the parent id from each', () => {
    const wire = toPublicValidationDetail(listRow, tables);
    expect(wire.tables).toEqual([
      { tableName: 'customers', sourceCount: 1000, destCount: 1000, matchPct: 100 },
      { tableName: 'order_items', sourceCount: 200_000, destCount: 199_500, matchPct: 99.75 },
    ]);
  });

  it('keeps every summary field the list form has', () => {
    const summary = toPublicValidation(listRow);
    const { tables: _tables, ...detail } = toPublicValidationDetail(listRow, tables);
    expect(detail).toEqual(summary);
  });
});
