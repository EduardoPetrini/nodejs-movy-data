import { describe, it, expect } from 'vitest';
import type { RunRow } from '../../server/repositories/runs.repo';
import { mayReadLogs, toPublicRun, toPublicRunListItem } from '../../server/serializers/run.serializer';

const row: RunRow = {
  id: 'run-1',
  orgId: 'org-1',
  definitionId: 'def-1',
  sourceConnectionId: 'conn-src',
  targetConnectionId: 'conn-dst',
  sourceEngine: 'postgres',
  sourceDatabase: 'movy_fixture_src',
  targetEngine: 'postgres',
  targetDatabase: 'movy_fixture_dst',
  mode: 'full',
  status: 'running',
  simulated: false,
  journalPath: '/var/movy/runs/run-1.ndjson',
  pid: 4242,
  lastSeq: 117,
  rowsDone: 150_000,
  rowsTotal: 315_000,
  tablesDone: 2,
  tablesTotal: 5,
  errorName: null,
  errorMessage: null,
  requestedByUserId: 'user-1',
  cancelRequestedByUserId: null,
  cancelRequestedAt: null,
  startedAt: new Date('2026-09-07T21:29:52.601Z'),
  finishedAt: null,
  durationMs: null,
  createdAt: new Date('2026-09-07T21:29:52.000Z'),
  updatedAt: new Date('2026-09-07T21:30:00.000Z'),
};

describe('toPublicRun', () => {
  it('never exposes the journal path or pid to anyone', () => {
    // Both are host filesystem and process detail. Built up rather than torn
    // down, so there is no branch that could emit them by omission.
    for (const role of ['viewer', 'editor', 'admin'] as const) {
      const json = JSON.stringify(toPublicRun(row, role));
      expect(json).not.toContain('journalPath');
      expect(json).not.toContain(row.journalPath);
      expect(json).not.toContain('4242');
      expect(json).not.toContain('orgId');
    }
  });

  it('withholds the connection ids from a viewer', () => {
    const asViewer = toPublicRun(row, 'viewer');
    expect(asViewer.sourceConnectionId).toBeUndefined();
    expect(asViewer.targetConnectionId).toBeUndefined();
    expect(Object.hasOwn(asViewer, 'sourceConnectionId')).toBe(false);
  });

  it('gives an editor the connection ids', () => {
    expect(toPublicRun(row, 'editor').sourceConnectionId).toBe('conn-src');
  });

  it('shows every role the same safe endpoints — engine and database only', () => {
    // The same pair SafeEndpoint carries on the event stream. History must not
    // reveal more than watching the run live did.
    for (const role of ['viewer', 'editor', 'admin'] as const) {
      expect(toPublicRun(row, role).source).toEqual({ engine: 'postgres', database: 'movy_fixture_src' });
    }
  });

  it('derives pct rather than trusting a stored one', () => {
    expect(toPublicRun(row, 'admin').progress.pct).toBeCloseTo(47.619, 2);
  });

  it('reports 0% rather than NaN before a total is known', () => {
    const fresh = { ...row, rowsDone: 0, rowsTotal: 0 };
    expect(toPublicRun(fresh, 'admin').progress.pct).toBe(0);
  });

  it('caps pct at 100 — rowsCopied over-reports by ~0.09%', () => {
    // table-copy.worker.ts double-counts a row straddling a COPY chunk
    // boundary, so rowsDone can exceed rowsTotal. A 100.09% bar is a bug
    // report waiting to happen.
    const over = { ...row, rowsDone: 315_300, rowsTotal: 315_000 };
    expect(toPublicRun(over, 'admin').progress.pct).toBe(100);
  });

  it('reports no error when there is none', () => {
    expect(toPublicRun(row, 'admin').error).toBeNull();
  });

  it('names an error that has a message but no name', () => {
    const failed = { ...row, status: 'failed' as const, errorMessage: 'relation does not exist' };
    expect(toPublicRun(failed, 'admin').error).toEqual({ name: 'Error', message: 'relation does not exist' });
  });

  it('marks a simulated run as such', () => {
    expect(toPublicRun({ ...row, simulated: true }, 'viewer').simulated).toBe(true);
  });
});

describe('mayReadLogs', () => {
  it('excludes viewers, who have run:read but not run:log:read', () => {
    // Movy's logs quote SQL, table names and driver errors.
    expect(mayReadLogs('viewer')).toBe(false);
    expect(mayReadLogs('editor')).toBe(true);
    expect(mayReadLogs('admin')).toBe(true);
  });
});

describe('the definition a run came from', () => {
  it('carries the id to every role, including a viewer', () => {
    // It is not credential metadata: a viewer already sees the run itself, and
    // without the id their ledger cannot group a migration's history at all.
    for (const role of ['viewer', 'editor', 'admin'] as const) {
      expect(toPublicRun(row, role).definitionId).toBe('def-1');
    }
  });

  it('reports no name when the caller holds only the row', () => {
    // The launch handler and the socket hub have a RunRow and no join. Null is
    // the truthful answer there; a lie the type forced would be worse.
    expect(toPublicRun(row, 'admin').definitionName).toBeNull();
  });

  it('takes the name from the join when the list handler supplies it', () => {
    const wire = toPublicRunListItem({ run: row, definitionName: 'Nightly reporting' }, 'viewer');
    expect(wire.definitionName).toBe('Nightly reporting');
  });

  it('reports both as null for an ad-hoc run, which is a first-class run', () => {
    const adhoc = toPublicRunListItem(
      { run: { ...row, definitionId: null }, definitionName: null },
      'editor'
    );
    expect(adhoc.definitionId).toBeNull();
    expect(adhoc.definitionName).toBeNull();
  });
});
