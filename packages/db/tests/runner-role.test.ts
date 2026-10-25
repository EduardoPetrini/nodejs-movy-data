import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshMetaDb } from './helpers/meta-db';
import { RUNNER_GRANTS, RUNNER_ROLE, ensureRunnerRole } from '../src/runner-role';

/**
 * Against PGlite with the real migrations, and as the role itself: a test of
 * what the grant statements say would only test that they say it.
 */
let db: PGlite;

beforeAll(async () => {
  db = await freshMetaDb();
  await ensureRunnerRole(db, "it's-a-pass'word");
});

afterAll(async () => {
  await db.close();
});

async function asRunner<T>(fn: () => Promise<T>): Promise<T> {
  await db.query(`SET ROLE ${RUNNER_ROLE}`);
  try {
    return await fn();
  } finally {
    await db.query('RESET ROLE');
  }
}

describe('the runner role', () => {
  it('cannot read connections, the credential store at rest', async () => {
    await expect(asRunner(() => db.query(`SELECT 1 FROM connections LIMIT 1`))).rejects.toThrow(/permission denied/);
  });

  it('cannot read any table it is not granted, including ones added after it was written', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const granted = new Set(RUNNER_GRANTS.map((g) => g.table));
    const others = rows.map((r) => r.table_name).filter((t) => !granted.has(t));
    expect(others).toEqual(expect.arrayContaining(['connections', 'users', 'organizations', 'platform_admins']));
    for (const table of others) {
      await expect(asRunner(() => db.query(`SELECT 1 FROM "${table}" LIMIT 1`)), table).rejects.toThrow(/permission denied/);
    }
  });

  it('reads every table the agent works from', async () => {
    for (const { table } of RUNNER_GRANTS) {
      await expect(asRunner(() => db.query(`SELECT 1 FROM ${table} LIMIT 1`))).resolves.toBeDefined();
    }
  });

  it('cannot queue a run or a probe: only the console does', async () => {
    await expect(asRunner(() => db.query(`INSERT INTO runs (org_id) VALUES (gen_random_uuid())`))).rejects.toThrow(
      /permission denied/
    );
    await expect(asRunner(() => db.query(`DELETE FROM runner_probes`))).rejects.toThrow(/permission denied/);
  });

  it('can register itself, as the agent does at boot', async () => {
    await asRunner(() =>
      db.query(
        `INSERT INTO runners (id, class, version, slots, state, started_at, last_heartbeat_at)
         VALUES ('r-1', 'default', 'v', 1, 'online', now(), now())`
      )
    );
    const { rows } = await db.query(`SELECT id FROM runners WHERE id = 'r-1'`);
    expect(rows).toHaveLength(1);
  });

  it('is safe to apply again, and takes back a grant that is no longer listed', async () => {
    await db.query(`GRANT SELECT ON connections TO ${RUNNER_ROLE}`);
    await ensureRunnerRole(db, 'another');
    await expect(asRunner(() => db.query(`SELECT 1 FROM connections`))).rejects.toThrow(/permission denied/);
  });

  it('refuses an empty password rather than creating a role anyone can log in as', async () => {
    await expect(ensureRunnerRole(db, '')).rejects.toThrow(/password/);
  });
});
