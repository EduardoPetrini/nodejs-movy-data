import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { freshMetaDb } from '../../../../packages/db/tests/helpers/meta-db';
import { ProbeWorker, sqlProbeQueue, type SqlClient } from '@movy/runner/agent';
import type { ProbeRequest } from '@movy/runner/probes';
import { DatabaseType } from '@movy/core';
import { ProbeWaiters } from '../../server/probes/probe-waiters';
import { runProbe } from '../../server/probes/run-probe';

/**
 * The console's half and the runner's half of a probe, against one PGlite
 * with the real migrations: seal → enqueue → claim → open → execute →
 * complete → take. Only the executor is fake; it would open a real database.
 */
const ORG = '11111111-1111-1111-1111-111111111111';

let db: PGlite;
let sql: SqlClient;
let worker: ProbeWorker | undefined;
const seen: ProbeRequest[] = [];

const request: ProbeRequest = {
  kind: 'test',
  config: { type: DatabaseType.POSTGRES, host: 'pg', port: 5432, user: 'u', password: 'hunter2-long', database: 'shop' },
};

beforeAll(() => {
  process.env.NUXT_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

beforeEach(async () => {
  db = await freshMetaDb();
  sql = db as unknown as SqlClient;
  seen.length = 0;
  await db.query(`INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme')`, [ORG]);
  await db.query(
    `INSERT INTO runners (id, class, version, slots, state, started_at, last_heartbeat_at)
     VALUES ('agent-1', 'default', '1', 1, 'online', now(), now())`
  );
});

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
});

function startWorker(): ProbeWorker {
  worker = new ProbeWorker({
    queue: sqlProbeQueue(sql, 'agent-1', 'default'),
    slots: 1,
    pollIntervalMs: 0,
    execute: async (req) => {
      seen.push(req);
      return { ok: false, latencyMs: 9, error: 'The username or password was rejected.', errorKind: 'auth' };
    },
  });
  return worker;
}

async function probeRows(): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM runner_probes`);
  return rows[0].n;
}

describe('runProbe', () => {
  it('gets the runner\'s answer back, opened with the request the console sealed, and leaves no row', async () => {
    const w = startWorker();
    const outcome = await runProbe(
      { sql, waiters: new ProbeWaiters(), wake: () => void w.wake() },
      { orgId: ORG, runnerClass: 'default', request, timeoutMs: 5_000 }
    );

    expect(outcome).toEqual({
      status: 'done',
      result: { ok: false, latencyMs: 9, error: 'The username or password was rejected.', errorKind: 'auth' },
    });
    expect(seen).toEqual([request]);
    expect(await probeRows()).toBe(0);
  });

  it('answers no_runner at once, queuing nothing, when no runner of the class is online', async () => {
    await db.query(`INSERT INTO runner_classes (name, label) VALUES ('large', 'Large')`);
    const outcome = await runProbe(
      { sql, waiters: new ProbeWaiters() },
      { orgId: ORG, runnerClass: 'large', request, timeoutMs: 5_000 }
    );
    expect(outcome).toEqual({ status: 'no_runner' });
    expect(await probeRows()).toBe(0);
  });

  it('times out when the runner stays silent, and deletes the request it was holding', async () => {
    const outcome = await runProbe(
      { sql, waiters: new ProbeWaiters() },
      { orgId: ORG, runnerClass: 'default', request, timeoutMs: 50 }
    );
    expect(outcome).toEqual({ status: 'timeout' });
    expect(await probeRows()).toBe(0);
  });

  it('stores the request sealed: the password is never in the row', async () => {
    let captured = '';
    await runProbe(
      { sql, waiters: new ProbeWaiters(), wake: () => void db.query<{ c: Buffer }>(`SELECT ciphertext AS c FROM runner_probes`).then(({ rows }) => {
        captured = Buffer.from(rows[0]?.c ?? []).toString('utf8');
      }) },
      { orgId: ORG, runnerClass: 'default', request, timeoutMs: 50 }
    );
    expect(captured.length).toBeGreaterThan(0);
    expect(captured).not.toContain('hunter2-long');
  });
});
