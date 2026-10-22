import { describe, it, expect, vi } from 'vitest';
import { MigrationOrchestrator } from '../../../src/application/services/migration-orchestrator.service';
import { DatabaseAdapterRegistry, DatabaseAdapterSet } from '../../../src/infrastructure/database/registry';
import { DatabaseType, ConnectionConfig } from '../../../src/domain/types/connection.types';
import { ILogger } from '../../../src/domain/ports/logger.port';
import { IDatabaseConnection } from '../../../src/domain/ports/database.port';
import { DatabaseSchema } from '../../../src/domain/types/schema.types';
import { SchemaDiff, MigrationResult } from '../../../src/domain/types/migration.types';
import { MigrationEvent } from '../../../src/domain/types/events.types';
import { composeSink } from '../../../src/application/events';
import {
  buildNeedles,
  redactString,
  redactValue,
  createRedactingSink,
  REDACTED,
  MIN_REDACTABLE_SECRET_LENGTH,
} from '../../../src/application/events/redacting-sink';
import { SinkLogger } from '../../../src/infrastructure/logging/sink-logger.adapter';

/**
 * The worst plausible bug in this project is a database password reaching a
 * screen. Events are broadcast to every subscriber of a run including read-only
 * viewers, journals are attached to issues as replay fixtures, and both carry
 * two strings — a log message and an error message — written by code that never
 * heard of `SafeEndpoint`.
 *
 * These tests assert the OUTPUT, not the implementation: they drive a real
 * orchestrator whose driver throws the password back at it, and then search
 * every byte that came out. A future change that widens an event type, adds a
 * field, or logs a config fails here rather than in production.
 */

const SOURCE_PASSWORD = 'hunter2-source-Pa55w0rd';
const TARGET_PASSWORD = 'hunter2-target-S3cret!';

function makeLogger(): ILogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeConfig(database: string, password: string): ConnectionConfig {
  return {
    type: DatabaseType.POSTGRES,
    host: 'db.internal',
    port: 5432,
    user: 'movy',
    password,
    database,
  };
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

/**
 * A driver that fails the way the dangerous ones do: quoting the DSN it was
 * handed, password and all. This is not hypothetical shaping — it is the
 * shape that makes redaction necessary rather than decorative.
 */
function makeLeakyConnection(config: ConnectionConfig): IDatabaseConnection {
  const dsn = `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`;
  return {
    connect: vi.fn().mockRejectedValue(new Error(`connection failed for "${dsn}" (SQLSTATE 28P01)`)),
    query: vi.fn().mockResolvedValue([]),
    getClient: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAdapterSet(
  createConnection: (config: ConnectionConfig) => IDatabaseConnection,
  result: MigrationResult
): DatabaseAdapterSet {
  return {
    adminDatabase: 'postgres',
    ensureDatabase: vi.fn().mockResolvedValue(true),
    createConnection: vi.fn(createConnection),
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

const OK_RESULT: MigrationResult = { tables: [], totalDurationMs: 1, success: true };

describe('credential redaction — the sink', () => {
  it('replaces a secret wherever it appears in an event', () => {
    const out: MigrationEvent[] = [];
    const sink = composeSink('run-1', (e) => out.push(e), {
      throttleMs: 0,
      secrets: [SOURCE_PASSWORD],
    });

    sink({ type: 'log', level: 'error', message: `psql: password=${SOURCE_PASSWORD} rejected` });

    expect(out).toHaveLength(1);
    expect(JSON.stringify(out[0])).not.toContain(SOURCE_PASSWORD);
    expect((out[0] as { message: string }).message).toBe(`psql: password=${REDACTED} rejected`);
  });

  it('catches a secret that leaked in percent-encoded form inside a URI', () => {
    const password = 'p@ss word/99';
    const encoded = encodeURIComponent(password);
    expect(encoded).not.toBe(password);

    const out: MigrationEvent[] = [];
    const sink = composeSink('run-1', (e) => out.push(e), { throttleMs: 0, secrets: [password] });
    sink({ type: 'log', level: 'error', message: `postgres://movy:${encoded}@db/app failed` });

    expect(JSON.stringify(out[0])).not.toContain(encoded);
  });

  it('scrubs nested fields, not only top-level strings', () => {
    const nested = redactValue(
      { a: { b: [{ c: `x${SOURCE_PASSWORD}y` }] }, n: 1, nul: null },
      buildNeedles([SOURCE_PASSWORD])
    );
    expect(JSON.stringify(nested)).not.toContain(SOURCE_PASSWORD);
    // Non-strings survive intact: redaction must not coerce the payload.
    expect(nested.n).toBe(1);
    expect(nested.nul).toBeNull();
  });

  it('does not mutate the event it was given', () => {
    const original = { type: 'log' as const, level: 'info' as const, message: SOURCE_PASSWORD };
    createRedactingSink(() => {}, [SOURCE_PASSWORD])(original);
    expect(original.message).toBe(SOURCE_PASSWORD);
  });

  it('leaves events untouched when there is nothing to redact', () => {
    const event = { type: 'log' as const, level: 'info' as const, message: 'hello' };
    let received: unknown;
    createRedactingSink((e) => { received = e; }, [])(event);
    // Identity, not a copy: the no-secrets path must not clone every event.
    expect(received).toBe(event);
  });

  it('ignores secrets too short to redact safely', () => {
    // A two-character password appears inside ordinary words; redacting it
    // would shred the timeline and advertise the password by the gaps.
    expect(buildNeedles(['ab'])).toEqual([]);
    expect(redactString('a table called orders', buildNeedles(['or']))).toBe('a table called orders');
    expect(MIN_REDACTABLE_SECRET_LENGTH).toBeGreaterThan(2);
  });

  it('matches the longest secret first when one contains another', () => {
    const needles = buildNeedles(['secret', 'secretlonger']);
    expect(redactString('secretlonger', needles)).toBe(REDACTED);
  });

  it('fails closed past the depth cap rather than passing a string it never searched', () => {
    // No real event nests this deep — `plan_ready` is the deepest at four
    // levels — so this is about which way the cap fails, not about a shape the
    // system produces. A net that stops descending and then forwards whatever
    // it could not inspect is open at exactly the depth someone would aim for.
    let deep: unknown = `leading ${SOURCE_PASSWORD} trailing`;
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };

    const scrubbed = redactValue(deep, buildNeedles([SOURCE_PASSWORD]));
    expect(JSON.stringify(scrubbed)).not.toContain(SOURCE_PASSWORD);
    // The subtree it could not walk is replaced, not forwarded — passing the
    // container through was the first attempt at this and leaked the string
    // sitting inside it.
    expect(JSON.stringify(scrubbed)).toContain(REDACTED);
  });

  it('still passes shallow non-strings through untouched', () => {
    // The depth guard must not coerce an ordinary payload: only what it cannot
    // inspect is replaced.
    const event = redactValue(
      { a: 1, b: true, c: null, d: `x${SOURCE_PASSWORD}y` },
      buildNeedles([SOURCE_PASSWORD])
    );
    expect(event.a).toBe(1);
    expect(event.b).toBe(true);
    expect(event.c).toBeNull();
    expect(event.d).not.toContain(SOURCE_PASSWORD);
  });
});

describe('credential redaction — a real run', () => {
  /**
   * Drives the orchestrator with a driver that echoes the DSN, then searches
   * every emitted byte. This is the assertion that matters: it does not know
   * which field the password would have travelled in.
   */
  async function runAndCollect(): Promise<string> {
    const source = makeConfig('app_src', SOURCE_PASSWORD);
    const target = makeConfig('app_dst', TARGET_PASSWORD);

    const registry = new DatabaseAdapterRegistry();
    registry.register(
      DatabaseType.POSTGRES,
      makeAdapterSet((config) => makeLeakyConnection(config), OK_RESULT)
    );

    const events: MigrationEvent[] = [];
    const emit = composeSink('run-leak', (e) => events.push(e), {
      throttleMs: 0,
      secrets: [source.password, target.password],
    });

    // SinkLogger is how ~60 existing logger.* calls reach the stream, including
    // the connection-retry warnings that interpolate a driver's message.
    const logger = new SinkLogger(emit);
    const orchestrator = new MigrationOrchestrator(registry, logger);

    await expect(orchestrator.run(source, target, { runId: 'run-leak', emit })).rejects.toThrow();
    emit.flush();

    // Every byte a subscriber, a journal or the projection would ever see.
    return events.map((e) => JSON.stringify(e)).join('\n');
  }

  it('never emits either password, in any event, in any field', async () => {
    const wire = await runAndCollect();

    expect(wire).not.toContain(SOURCE_PASSWORD);
    expect(wire).not.toContain(TARGET_PASSWORD);
  });

  it('still emits the failure, redacted rather than suppressed', async () => {
    const wire = await runAndCollect();

    // Redaction that silently drops the error would be worse than the leak:
    // the run would fail with no reason shown anywhere.
    expect(wire).toContain(REDACTED);
    expect(wire).toContain('28P01');
    expect(wire).toContain('run_finished');
  });

  it('keeps the non-secret endpoint fields, which are what the UI draws', async () => {
    const wire = await runAndCollect();

    expect(wire).toContain('app_src');
    expect(wire).toContain('app_dst');
    // The host and username are not secrets, but SafeEndpoint carries neither,
    // and this asserts that the "events describe progress, never configuration"
    // rule is still true of run_started.
    const started = JSON.parse(wire.split('\n')[0]) as { source: Record<string, unknown> };
    expect(Object.keys(started.source).sort()).toEqual(['database', 'engine']);
  });
});
