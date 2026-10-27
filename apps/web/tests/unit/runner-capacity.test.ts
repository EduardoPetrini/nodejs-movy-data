import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshMetaDb } from '../../../../packages/db/tests/helpers/meta-db';
import { UnknownRunnerClassError, loadClassCapacity } from '../../server/runners/provisioner';
import { loadClassDemand } from '../../server/runners/autoscale';
import type { SqlClient } from '@movy/runner/agent';

/** Against PGlite with the real migrations, like the other runner readers. */
const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

let db: PGlite;
let sql: SqlClient;

async function runner(id: string, cls: string, state: string, slots = 1, busy = 0) {
  await db.query(
    `INSERT INTO runners (id, class, version, slots, busy, state, started_at, last_heartbeat_at)
     VALUES ($1, $2, 'spec-v1', $3, $4, $5, now(), now())`,
    [id, cls, slots, busy, state]
  );
}

async function run(org: string, cls: string, status = 'queued', lockKey: string | null = null) {
  await db.query(
    `INSERT INTO runs (id, org_id, source_engine, source_database, target_engine, target_database, runner_class, status, target_lock_key)
     VALUES (gen_random_uuid(), $1, 'postgres', 'a', 'postgres', 'b', $2, $3, $4)`,
    [org, cls, status, lockKey]
  );
}

beforeEach(async () => {
  db = await freshMetaDb();
  sql = db as unknown as SqlClient;
  for (const [id, slug] of [[ORG_A, 'a'], [ORG_B, 'b']]) {
    await db.query(`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
  }
  await db.query(
    `INSERT INTO runner_classes (name, label, max_replicas, cpu_millis, memory_mb) VALUES ('large', 'Large', 2, 4000, 8192)`
  );
});

describe('loadClassCapacity', () => {
  it('reads the class and the runners alive in it, draining included and offline not', async () => {
    await runner('l1', 'large', 'online');
    await runner('l2', 'large', 'draining');
    await runner('l3', 'large', 'offline');

    const c = await loadClassCapacity(sql, 'large');
    expect(c).toMatchObject({ name: 'large', label: 'Large', maxReplicas: 2, cpuMillis: 4000, memoryMb: 8192 });
    expect([...c.liveRunnerIds].sort()).toEqual(['l1', 'l2']);
  });

  it('refuses a class that does not exist or that the class file dropped', async () => {
    await expect(loadClassCapacity(sql, 'huge')).rejects.toBeInstanceOf(UnknownRunnerClassError);
    await db.query(`UPDATE runner_classes SET configured = false WHERE name = 'large'`);
    await expect(loadClassCapacity(sql, 'large')).rejects.toBeInstanceOf(UnknownRunnerClassError);
  });
});

describe('loadClassDemand', () => {
  it('counts queued work across every org, since runners are shared', async () => {
    await run(ORG_A, 'large');
    await run(ORG_B, 'large');
    await runner('l1', 'large', 'online', 1, 1);

    const large = (await loadClassDemand(sql)).find((d) => d.name === 'large');
    expect(large).toEqual({ name: 'large', queued: 2, freeSlots: 0, live: 1, maxReplicas: 2 });
  });

  it('does not count a run waiting only on its destination: another runner would wait on the same lock', async () => {
    await run(ORG_A, 'default', 'running', 'dst-1');
    await run(ORG_B, 'default', 'queued', 'dst-1');

    const def = (await loadClassDemand(sql)).find((d) => d.name === 'default');
    expect(def?.queued).toBe(0);
  });
});
