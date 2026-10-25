import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { schema, type Db } from '@movy/db';
import { freshMetaDb } from '../../../../../packages/db/tests/helpers/meta-db';
import { RUN_SETTLED_CHANNEL } from '../../../src/agent/channels';
import { finaliseRunIfUnsettled } from '../../../src/agent/ingestion';
import { cancelQueuedRun, claimNextRun, registerRunner, settleClaimedRun, sweep, type SqlClient } from '../../../src/agent/queue-store';

/**
 * Every settlement of a run reaches a watching browser.
 *
 * Most settlements emit no event — a fenced or crashed runner, a spec that
 * could not be read, the sweeper — so `movy_run_settled` is the only thing that
 * moves the run page off "running". It used to be sent by the sweeper's own
 * statement only, and every other path left the page running forever. The
 * `runs_settled_notify` trigger (migration 0009) makes it structural; this
 * file drives each path the application has, against the real migrations,
 * plus one bare UPDATE standing in for whichever path is written next.
 */
const ORG = '11111111-1111-1111-1111-111111111111';

let pg: PGlite;
let sql: SqlClient;
let db: Db;
let heard: string[];

async function runningRun(): Promise<string> {
  const id = randomUUID();
  await pg.query(
    `INSERT INTO runs (id, org_id, source_engine, source_database, target_engine, target_database, runner_class)
     VALUES ($1, $2, 'postgres', 'a', 'postgres', 'b', 'default')`,
    [id, ORG]
  );
  await pg.query(`INSERT INTO run_specs (run_id, spec_version, ciphertext) VALUES ($1, 1, $2)`, [id, Buffer.from('sealed')]);
  const claimed = await claimNextRun(sql, 'agent-1', 'default');
  expect(claimed?.id).toBe(id);
  return id;
}

async function announced(): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 20));
  return heard.map((p) => (JSON.parse(p) as { runId: string }).runId);
}

beforeEach(async () => {
  pg = await freshMetaDb();
  sql = pg as unknown as SqlClient;
  db = drizzle(pg, { schema }) as unknown as Db;
  await pg.query(`INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme')`, [ORG]);
  await registerRunner(sql, { id: 'agent-1', runnerClass: 'default', version: '1', slots: 4 });
  heard = [];
  await pg.listen(RUN_SETTLED_CHANNEL, (payload) => heard.push(payload));
});

describe('every settlement of a run is announced on movy_run_settled', () => {
  it('a runner that exited without an outcome — fenced, crashed or killed', async () => {
    const run = await runningRun();
    await finaliseRunIfUnsettled(db, run, { status: 'failed', errorName: 'RunnerExited', errorMessage: 'signal SIGKILL' });
    expect(await announced()).toEqual([run]);
  });

  it('a run the agent refused after claiming it', async () => {
    const run = await runningRun();
    await settleClaimedRun(sql, run, { status: 'failed', errorName: 'RunSpecMissing', errorMessage: 'gone' });
    expect(await announced()).toEqual([run]);
  });

  it('a run the sweeper found without a lease', async () => {
    const run = await runningRun();
    await pg.query(`UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [run]);
    await sweep(sql);
    expect(await announced()).toEqual([run]);
  });

  it('a queued run cancelled outright', async () => {
    const user = randomUUID();
    await pg.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, 'a@x.io', 'A', 'x')`, [user]);
    const run = randomUUID();
    await pg.query(
      `INSERT INTO runs (id, org_id, source_engine, source_database, target_engine, target_database)
       VALUES ($1, $2, 'postgres', 'a', 'postgres', 'b')`,
      [run, ORG]
    );
    await cancelQueuedRun(sql, ORG, run, user);
    expect(await announced()).toEqual([run]);
  });

  it('any other statement that settles a run — the path nobody has written yet', async () => {
    const run = await runningRun();
    await pg.query(`UPDATE runs SET status = 'succeeded' WHERE id = $1`, [run]);
    expect(await announced()).toEqual([run]);
  });

  it('only on settling: moving between live states, or re-settling a settled run, says nothing', async () => {
    const run = await runningRun();
    await pg.query(`UPDATE runs SET status = 'cancelling' WHERE id = $1`, [run]);
    await pg.query(`UPDATE runs SET last_seq = 5 WHERE id = $1`, [run]);
    expect(await announced()).toEqual([]);

    await pg.query(`UPDATE runs SET status = 'cancelled' WHERE id = $1`, [run]);
    await finaliseRunIfUnsettled(db, run, { status: 'failed' });
    await pg.query(`UPDATE runs SET status = 'failed' WHERE id = $1`, [run]);
    expect(await announced()).toEqual([run]);
  });

  it('nothing when the settling transaction rolls back', async () => {
    const run = await runningRun();
    await pg.transaction(async (tx) => {
      await tx.query(`UPDATE runs SET status = 'failed' WHERE id = $1`, [run]);
      await tx.rollback();
    });
    expect(await announced()).toEqual([]);
  });
});
