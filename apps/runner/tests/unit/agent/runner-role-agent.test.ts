import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { schema, type Db } from '@movy/db';
import { freshMetaDb } from '../../../../../packages/db/tests/helpers/meta-db';
import { RUNNER_ROLE, ensureRunnerRole } from '../../../../../packages/db/src/runner-role';
import {
  claimNextRun, heartbeat, reattachableRuns, registerRunner, setRunnerState, settleClaimedRun, takeRunSpec, type SqlClient,
} from '../../../src/agent/queue-store';
import { claimProbe, completeProbe, enqueueProbe } from '../../../src/agent/probe-store';
import { applyProjection, finaliseRunIfUnsettled, markRunLaunched } from '../../../src/agent/ingestion';
import { projectEvents } from '../../../src/agent/run-projection';
import type { MigrationEvent } from '@movy/core';

/**
 * Every statement a standalone agent runs, run AS `movy_runner`. The role test
 * in @movy/db proves what the role cannot do; this proves the agent still can
 * — a grant one privilege too tight fails a run at its first claim, in
 * production only, since the embedded agent connects as the owner.
 */
const ORG = '11111111-1111-1111-1111-111111111111';

let pg: PGlite;
let sql: SqlClient;
let db: Db;

async function asRunner<T>(fn: () => Promise<T>): Promise<T> {
  await pg.query(`SET ROLE ${RUNNER_ROLE}`);
  try {
    return await fn();
  } finally {
    await pg.query('RESET ROLE');
  }
}

async function queueRun(): Promise<string> {
  const id = randomUUID();
  await pg.query(
    `INSERT INTO runs (id, org_id, source_engine, source_database, target_engine, target_database, runner_class)
     VALUES ($1, $2, 'postgres', 'a', 'postgres', 'b', 'default')`,
    [id, ORG]
  );
  await pg.query(`INSERT INTO run_specs (run_id, spec_version, ciphertext) VALUES ($1, 1, '\\x00')`, [id]);
  return id;
}

beforeAll(async () => {
  pg = await freshMetaDb();
  sql = pg as unknown as SqlClient;
  db = drizzle(pg, { schema }) as unknown as Db;
  await pg.query(`INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme')`, [ORG]);
  await ensureRunnerRole(pg, 'runner-pw');
});

afterAll(async () => {
  await pg.close();
});

describe('a standalone agent under the runner role', () => {
  it('registers, claims, takes the spec, heartbeats and re-attaches', async () => {
    const runId = await queueRun();
    await asRunner(async () => {
      await registerRunner(sql, { id: 'agent-r', runnerClass: 'default', version: 'v', slots: 1, provisionedBy: 'docker' });
      expect((await claimNextRun(sql, 'agent-r', 'default'))?.id).toBe(runId);
      expect(await takeRunSpec(sql, runId)).not.toBeNull();
      expect((await heartbeat(sql, 'agent-r', 1)).held).toEqual([runId]);
      await markRunLaunched(db, runId, { pid: 42, journalPath: '/tmp/j.ndjson' });
      expect(await reattachableRuns(sql, 'agent-r', { includeOwnerless: false })).toHaveLength(1);
    });
  });

  it('stores events and their projections', async () => {
    const runId = await queueRun();
    const events: MigrationEvent[] = [
      { type: 'step_started', stepId: 'inspect_and_diff', ordinal: 3, runId, seq: 1, at: new Date().toISOString() },
      { type: 'log', level: 'info', message: 'hello', runId, seq: 2, at: new Date().toISOString() },
    ];
    await asRunner(async () => {
      await claimNextRun(sql, 'agent-r', 'default');
      await applyProjection(db, runId, projectEvents(events));
      await applyProjection(db, runId, projectEvents(events));
    });
    const { rows } = await pg.query(`SELECT count(*)::int AS n FROM run_events WHERE run_id = $1`, [runId]);
    expect(rows[0]).toEqual({ n: 2 });
  });

  it('settles a run it could not start, and one whose process ended without an outcome', async () => {
    const a = await queueRun();
    const b = await queueRun();
    await asRunner(async () => {
      await claimNextRun(sql, 'agent-r', 'default');
      await claimNextRun(sql, 'agent-r', 'default');
      expect(await settleClaimedRun(sql, a, { status: 'failed', errorName: 'X', errorMessage: 'x' })).toBe(true);
      expect(await finaliseRunIfUnsettled(db, b, { status: 'failed', errorName: 'RunnerGone' })).toBe(true);
    });
  });

  it('claims and answers a probe', async () => {
    const id = randomUUID();
    await enqueueProbe(sql, { id, orgId: ORG, kind: 'test', runnerClass: 'default', ciphertext: Buffer.from('s'), ttlMs: 60_000 });
    await asRunner(async () => {
      expect((await claimProbe(sql, 'agent-r', 'default'))?.id).toBe(id);
      expect(await completeProbe(sql, id, { ok: true, latencyMs: 3 })).toBe(true);
    });
  });

  it('goes offline on the way out', async () => {
    await asRunner(() => setRunnerState(sql, 'agent-r', 'offline'));
    const { rows } = await pg.query(`SELECT state FROM runners WHERE id = 'agent-r'`);
    expect(rows[0]).toEqual({ state: 'offline' });
  });
});
