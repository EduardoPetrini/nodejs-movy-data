import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MigrationOrchestrator } from '../../../src/application/services/migration-orchestrator.service';
import { DatabaseAdapterRegistry, DatabaseAdapterSet } from '../../../src/infrastructure/database/registry';
import { DatabaseType, ConnectionConfig } from '../../../src/domain/types/connection.types';
import { ILogger } from '../../../src/domain/ports/logger.port';
import { IDatabaseConnection } from '../../../src/domain/ports/database.port';
import { DatabaseSchema } from '../../../src/domain/types/schema.types';
import { SchemaDiff, MigrationResult } from '../../../src/domain/types/migration.types';
import {
  MigrationEvent,
  MigrationStepId,
  MIGRATION_STEP_ORDER,
} from '../../../src/domain/types/events.types';
import { composeSink } from '../../../src/application/events';
import { MigrationCancelledError } from '../../../src/domain/errors/migration.errors';

function makeLogger(): ILogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}
function makeConfig(db = 'src'): ConnectionConfig {
  return { type: DatabaseType.POSTGRES, host: 'localhost', port: 5432, user: 'u', password: 'p', database: db };
}
function emptySchema(): DatabaseSchema {
  return { tables: [], sequences: [], enums: [] };
}
function emptyDiff(): SchemaDiff {
  return {
    tablesToCreate: [], tablesToDrop: [], columnsToAdd: [], columnsToDrop: [],
    columnsToAlter: [], constraintsToAdd: [], constraintsToDrop: [],
    indexesToCreate: [], indexesToDrop: [], sequencesToCreate: [], enumsToCreate: [],
  };
}
function makeConnection(): IDatabaseConnection {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    getClient: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };
}
function makeAdapterSet(result: MigrationResult): DatabaseAdapterSet {
  return {
    adminDatabase: 'postgres',
    ensureDatabase: vi.fn().mockResolvedValue(true),
    createConnection: vi.fn(() => makeConnection()),
    createSchemaInspector: vi.fn(() => ({
      inspect: vi.fn().mockResolvedValue(emptySchema()),
      getTableRowEstimates: vi.fn().mockResolvedValue(new Map()),
    })),
    createSchemaSynchronizer: vi.fn(() => ({
      diff: vi.fn().mockReturnValue(emptyDiff()),
      apply: vi.fn().mockResolvedValue(undefined),
      disableTriggers: vi.fn().mockResolvedValue(undefined),
      enableTriggers: vi.fn().mockResolvedValue(undefined),
      createIndexes: vi.fn().mockResolvedValue(undefined),
      resetSequences: vi.fn().mockResolvedValue(undefined),
    })),
    createDataMigrator: vi.fn(() => ({ migrate: vi.fn().mockResolvedValue(result) })),
  };
}

describe('MigrationOrchestrator event stream', () => {
  let registry: DatabaseAdapterRegistry;
  let events: MigrationEvent[];
  const RUN_ID = 'run-1';

  function runWithEvents(result: MigrationResult, signal?: AbortSignal) {
    const orchestrator = new MigrationOrchestrator(registry, makeLogger());
    const emit = composeSink(RUN_ID, (e) => events.push(e));
    return orchestrator.run(makeConfig('src'), makeConfig('dst'), { runId: RUN_ID, emit, signal });
  }

  beforeEach(() => {
    events = [];
    registry = new DatabaseAdapterRegistry();
    registry.register(DatabaseType.POSTGRES, makeAdapterSet({ tables: [], totalDurationMs: 10, success: true }));
  });

  it('reports all nine steps, in MIGRATION_STEP_ORDER', async () => {
    await runWithEvents({ tables: [], totalDurationMs: 10, success: true });

    const started = events
      .filter((e): e is Extract<MigrationEvent, { type: 'step_started' }> => e.type === 'step_started')
      .map((e) => e.stepId);

    expect(started).toEqual([...MIGRATION_STEP_ORDER]);
    expect(started).toHaveLength(9);
  });

  it('pairs every step_started with a step_finished', async () => {
    await runWithEvents({ tables: [], totalDurationMs: 10, success: true });

    const started = events.filter((e) => e.type === 'step_started').length;
    const finished = events.filter((e) => e.type === 'step_finished').length;
    expect(finished).toBe(started);
    expect(events.filter((e) => e.type === 'step_finished' && e.status === 'ok')).toHaveLength(9);
  });

  it('brackets the run with run_started and a terminal run_finished', async () => {
    await runWithEvents({ tables: [], totalDurationMs: 10, success: true });

    expect(events[0].type).toBe('run_started');
    const last = events[events.length - 1];
    expect(last.type).toBe('run_finished');
    expect(last.type === 'run_finished' && last.status).toBe('succeeded');
  });

  it('assigns a strictly monotonic seq to every event', async () => {
    await runWithEvents({ tables: [], totalDurationMs: 10, success: true });

    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBe(1);
  });

  it('never puts host, port or credentials on run_started', async () => {
    await runWithEvents({ tables: [], totalDurationMs: 10, success: true });

    const started = events.find((e) => e.type === 'run_started');
    // Events are broadcast to read-only viewers, so they must describe progress,
    // never configuration.
    expect(JSON.stringify(started)).not.toContain('localhost');
    expect(JSON.stringify(started)).not.toContain('5432');
    expect(JSON.stringify(started)).not.toContain('"p"');
  });

  it('carries a step detail for create_database', async () => {
    await runWithEvents({ tables: [], totalDurationMs: 10, success: true });

    const step = events.find(
      (e): e is Extract<MigrationEvent, { type: 'step_finished' }> =>
        e.type === 'step_finished' && e.stepId === 'create_database'
    );
    expect(step?.detail).toEqual({ kind: 'create_database', database: 'dst', created: true });
  });

  it('marks the failing step and ends the run as failed', async () => {
    const boom = new Error('inspect exploded');
    const adapters = makeAdapterSet({ tables: [], totalDurationMs: 0, success: true });
    adapters.createSchemaInspector = vi.fn(() => ({
      inspect: vi.fn().mockRejectedValue(boom),
      getTableRowEstimates: vi.fn().mockResolvedValue(new Map()),
    }));
    registry = new DatabaseAdapterRegistry();
    registry.register(DatabaseType.POSTGRES, adapters);

    await expect(runWithEvents({ tables: [], totalDurationMs: 0, success: true })).rejects.toThrow(boom);

    const failedStep = events.find((e) => e.type === 'step_finished' && e.status === 'failed');
    expect(failedStep && failedStep.type === 'step_finished' && failedStep.stepId).toBe('inspect_and_diff');

    const last = events[events.length - 1];
    expect(last.type === 'run_finished' && last.status).toBe('failed');
  });

  it('reports a pre-aborted run as cancelled, not failed', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runWithEvents({ tables: [], totalDurationMs: 0, success: true }, controller.signal)
    ).rejects.toBeInstanceOf(MigrationCancelledError);

    const last = events[events.length - 1];
    expect(last.type === 'run_finished' && last.status).toBe('cancelled');
    // Nothing ran, so no step should have completed.
    expect(events.filter((e) => e.type === 'step_finished' && e.status === 'ok')).toHaveLength(0);
  });

  it('omits every event when no context is supplied', async () => {
    const orchestrator = new MigrationOrchestrator(registry, makeLogger());
    const result = await orchestrator.run(makeConfig('src'), makeConfig('dst'));
    expect(result.success).toBe(true);
    expect(events).toHaveLength(0);
  });
});
