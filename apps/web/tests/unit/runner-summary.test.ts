import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshMetaDb } from '../../../../packages/db/tests/helpers/meta-db';
import { loadRunnersSnapshot } from '../../server/runners/runner-summary';
import type { SqlClient } from '@movy/runner/agent';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

let db: PGlite;
let sql: SqlClient;

async function runner(id: string, cls: string, state: string, slots: number, busy: number) {
  await db.query(
    `INSERT INTO runners (id, class, version, slots, busy, state, started_at, last_heartbeat_at)
     VALUES ($1, $2, 'spec-v1', $3, $4, $5, now(), now())`,
    [id, cls, slots, busy, state]
  );
}

async function queued(org: string, cls: string) {
  await db.query(
    `INSERT INTO runs (id, org_id, source_engine, source_database, target_engine, target_database, runner_class)
     VALUES (gen_random_uuid(), $1, 'postgres', 'a', 'postgres', 'b', $2)`,
    [org, cls]
  );
}

beforeEach(async () => {
  db = await freshMetaDb();
  sql = db as unknown as SqlClient;
  for (const [id, slug] of [[ORG_A, 'a'], [ORG_B, 'b']]) {
    await db.query(`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
  }
  await db.query(`INSERT INTO runner_classes (name, label, description) VALUES ('large', 'Large', 'More memory')`);
});

describe('loadRunnersSnapshot', () => {
  it('counts online runners and free slots per class, default first', async () => {
    await runner('r1', 'default', 'online', 2, 1);
    await runner('r2', 'default', 'online', 1, 1);
    await runner('r3', 'default', 'offline', 4, 0);
    await runner('r4', 'large', 'draining', 1, 1);

    const snap = await loadRunnersSnapshot(sql, ORG_A, { includeRunners: false });

    expect(snap.classes).toEqual([
      { name: 'default', label: 'Default', description: null, isDefault: true, online: 2, draining: 0, totalSlots: 3, freeSlots: 1, queued: 0, onDemand: false },
      { name: 'large', label: 'Large', description: 'More memory', isDefault: false, online: 0, draining: 1, totalSlots: 0, freeSlots: 0, queued: 0, onDemand: false },
    ]);
  });

  it('marks the classes the provisioner runs on demand, and no other', async () => {
    const snap = await loadRunnersSnapshot(sql, ORG_A, { includeRunners: false, isOnDemand: (cls) => cls === 'large' });
    expect(snap.classes.map((c) => [c.name, c.onDemand])).toEqual([['default', false], ['large', true]]);
  });

  it('counts only this org\'s queued runs, never another org\'s', async () => {
    await queued(ORG_A, 'default');
    await queued(ORG_B, 'default');
    await queued(ORG_B, 'default');
    const snap = await loadRunnersSnapshot(sql, ORG_A, { includeRunners: false });
    expect(snap.classes.find((c) => c.name === 'default')?.queued).toBe(1);
  });

  it('names runners only when asked to — the admin view', async () => {
    await runner('host-7', 'default', 'online', 2, 0);
    expect((await loadRunnersSnapshot(sql, ORG_A, { includeRunners: false })).runners).toBeUndefined();

    const admin = await loadRunnersSnapshot(sql, ORG_A, { includeRunners: true });
    expect(admin.runners).toEqual([
      expect.objectContaining({ id: 'host-7', runnerClass: 'default', state: 'online', slots: 2, busy: 0, version: 'spec-v1' }),
    ]);
  });

  it('never reports a negative number of free slots', async () => {
    // busy can momentarily exceed slots if a runner restarts with fewer.
    await runner('r1', 'default', 'online', 1, 3);
    const snap = await loadRunnersSnapshot(sql, ORG_A, { includeRunners: false });
    expect(snap.classes[0].freeSlots).toBe(0);
  });

  it('lists an offline runner for an hour, then drops it from the admin view', async () => {
    // Every rebuild of a container gives its embedded agent a new hostname, so
    // without this the list grows by one dead runner per deploy, forever.
    await runner('fresh', 'default', 'offline', 1, 0);
    await runner('stale', 'default', 'offline', 1, 0);
    await db.query(`UPDATE runners SET last_heartbeat_at = now() - interval '2 hours' WHERE id = 'stale'`);
    const admin = await loadRunnersSnapshot(sql, ORG_A, { includeRunners: true });
    expect(admin.runners?.map((r) => r.id)).toEqual(['fresh']);
  });
});

