import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshMetaDb } from './helpers/meta-db';

/**
 * `runner_demand` is what KEDA scales on and what Compose's auto mode reads:
 * one definition of "work a new runner of this class could take now". Against
 * PGlite with the real migrations, so this is the view production runs.
 */
const ORG = '11111111-1111-1111-1111-111111111111';
let db: PGlite;

async function run(cls: string, status = 'queued', lockKey: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO runs (id, org_id, source_engine, source_database, target_engine, target_database, runner_class, status, target_lock_key)
     VALUES (gen_random_uuid(), $1, 'postgres', 'a', 'postgres', 'b', $2, $3, $4)`,
    [ORG, cls, status, lockKey]
  );
}

async function probe(cls: string, status = 'queued', expiresIn = '1 minute'): Promise<void> {
  await db.query(
    `INSERT INTO runner_probes (id, org_id, kind, runner_class, status, expires_at)
     VALUES (gen_random_uuid(), $1, 'test', $2, $3, now() + $4::interval)`,
    [ORG, cls, status, expiresIn]
  );
}

async function demand(): Promise<Record<string, { claimable_runs: number; queued_probes: number }>> {
  const { rows } = await db.query<{ runner_class: string; claimable_runs: number; queued_probes: number }>(
    `SELECT * FROM runner_demand`
  );
  return Object.fromEntries(rows.map((r) => [r.runner_class, { claimable_runs: r.claimable_runs, queued_probes: r.queued_probes }]));
}

beforeEach(async () => {
  db = await freshMetaDb();
  await db.query(`INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme')`, [ORG]);
  await db.query(`INSERT INTO runner_classes (name, label, max_replicas) VALUES ('large', 'Large', 2)`);
});

afterEach(async () => {
  await db.close();
});

describe('runner_demand', () => {
  it('has a row for every configured class, idle ones at zero', async () => {
    expect(await demand()).toEqual({
      default: { claimable_runs: 0, queued_probes: 0 },
      large: { claimable_runs: 0, queued_probes: 0 },
    });
  });

  it('counts queued runs per class, and not runs already claimed', async () => {
    await run('large');
    await run('large');
    await run('large', 'running');
    await run('default', 'cancelling');

    expect(await demand()).toMatchObject({ large: { claimable_runs: 2 }, default: { claimable_runs: 0 } });
  });

  it('does not count a run waiting only on its destination: a new runner would wait on the same lock', async () => {
    await run('default', 'running', 'dst-1');
    await run('large', 'queued', 'dst-1');
    await run('large', 'queued', 'dst-2');

    expect((await demand()).large?.claimable_runs).toBe(1);
  });

  it('counts unclaimed probes that can still be answered, so a probe "from large" can wake a Job', async () => {
    await probe('large');
    await probe('large', 'running');
    await probe('large', 'done');
    await probe('large', 'queued', '-1 second');

    expect((await demand()).large?.queued_probes).toBe(1);
  });

  it('leaves out a class the class file dropped: nothing would ever be offered it', async () => {
    await run('large');
    await db.query(`UPDATE runner_classes SET configured = false WHERE name = 'large'`);

    expect(Object.keys(await demand())).toEqual(['default']);
  });

  it('exposes a class and two counts, never an org, a run or a destination', async () => {
    const { fields } = await db.query(`SELECT * FROM runner_demand`);
    expect(fields.map((f) => f.name)).toEqual(['runner_class', 'claimable_runs', 'queued_probes']);
  });
});
