import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { freshMetaDb } from '../../../../../packages/db/tests/helpers/meta-db';
import { RUNNERS_CHANNEL } from '../../../src/agent/channels';
import {
  cancelQueuedRun,
  claimNextRun,
  heartbeat,
  reattachableRuns,
  registerRunner,
  setRunnerState,
  settleClaimedRun,
  sweep,
  takeRunSpec,
  type SqlClient,
} from '../../../src/agent/queue-store';

/**
 * Against PGlite with the real migrations: these are the statements that decide
 * who runs what, and a mock would only test that the mock agrees with itself.
 * What one connection cannot show is two agents racing — SKIP LOCKED under true
 * concurrency is left to the Compose meta-db (docs/runner-service-plan.md).
 */
const ORG = '11111111-1111-1111-1111-111111111111';

let db: PGlite;
let sql: SqlClient;

async function enqueue(opts: { runnerClass?: string; createdAt?: string; spec?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO runs (id, org_id, source_engine, source_database, target_engine, target_database, runner_class, created_at)
     VALUES ($1, $2, 'postgres', 'a', 'postgres', 'b', $3, coalesce($4::timestamptz, now()))`,
    [id, ORG, opts.runnerClass ?? 'default', opts.createdAt ?? null]
  );
  if (opts.spec !== false) {
    await db.query(`INSERT INTO run_specs (run_id, spec_version, ciphertext) VALUES ($1, 1, $2)`, [id, Buffer.from('sealed')]);
  }
  return id;
}

async function statusOf(id: string): Promise<Record<string, unknown>> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT status, runner_id, error_name, lease_expires_at > now() AS leased FROM runs WHERE id = $1`, [id]
  );
  return rows[0];
}

beforeEach(async () => {
  db = await freshMetaDb();
  sql = db as unknown as SqlClient;
  await db.query(`INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme')`, [ORG]);
  await db.query(`INSERT INTO runner_classes (name, label) VALUES ('large', 'Large')`);
  await registerRunner(sql, { id: 'agent-1', runnerClass: 'default', version: '1', slots: 1 });
});

describe('claimNextRun', () => {
  it('claims the oldest queued run of its class and leases it', async () => {
    const newer = await enqueue({ createdAt: '2026-10-22T10:00:01Z' });
    const older = await enqueue({ createdAt: '2026-10-22T10:00:00Z' });

    const claimed = await claimNextRun(sql, 'agent-1', 'default');

    expect(claimed).toEqual({ id: older, orgId: ORG, simulated: false });
    expect(await statusOf(older)).toMatchObject({ status: 'running', runner_id: 'agent-1', leased: true });
    expect(await statusOf(newer)).toMatchObject({ status: 'queued', runner_id: null });
  });

  it('never claims another class\'s run', async () => {
    await enqueue({ runnerClass: 'large' });
    expect(await claimNextRun(sql, 'agent-1', 'default')).toBeNull();
  });

  it('claims nothing twice: a claimed run is no longer queued', async () => {
    await enqueue();
    expect(await claimNextRun(sql, 'agent-1', 'default')).not.toBeNull();
    expect(await claimNextRun(sql, 'agent-2', 'default')).toBeNull();
  });
});

describe('takeRunSpec', () => {
  it('returns the sealed spec once and deletes it', async () => {
    const id = await enqueue();
    const spec = await takeRunSpec(sql, id);
    expect(spec?.specVersion).toBe(1);
    expect(spec?.ciphertext.toString()).toBe('sealed');
    expect(await takeRunSpec(sql, id)).toBeNull();
  });
});

describe('cancelQueuedRun', () => {
  it('wins or loses against a claim cleanly — exactly one of them takes the row', async () => {
    const user = randomUUID();
    await db.query(`INSERT INTO users (id, email) VALUES ($1, 'a@x.test')`, [user]);

    const cancelFirst = await enqueue();
    expect(await cancelQueuedRun(sql, ORG, cancelFirst, user)).toBe(true);
    expect(await claimNextRun(sql, 'agent-1', 'default')).toBeNull();
    expect(await statusOf(cancelFirst)).toMatchObject({ status: 'cancelled' });
    expect(await takeRunSpec(sql, cancelFirst)).toBeNull();

    const claimFirst = await enqueue();
    expect(await claimNextRun(sql, 'agent-1', 'default')).not.toBeNull();
    expect(await cancelQueuedRun(sql, ORG, claimFirst, user)).toBe(false);
    expect(await statusOf(claimFirst)).toMatchObject({ status: 'running' });
  });
});

describe('cancelQueuedRun scoping', () => {
  it('cannot cancel another org\'s queued run', async () => {
    const user = randomUUID();
    await db.query(`INSERT INTO users (id, email) VALUES ($1, 'b@x.test')`, [user]);
    const id = await enqueue();
    expect(await cancelQueuedRun(sql, '99999999-9999-9999-9999-999999999999', id, user)).toBe(false);
    expect(await statusOf(id)).toMatchObject({ status: 'queued' });
  });
});

describe('heartbeat', () => {
  it('extends the leases of the runs it holds and names the ones being cancelled', async () => {
    const a = await enqueue();
    const b = await enqueue();
    await claimNextRun(sql, 'agent-1', 'default');
    await claimNextRun(sql, 'agent-1', 'default');
    await db.query(`UPDATE runs SET status = 'cancelling' WHERE id = $1`, [b]);
    await db.query(`UPDATE runs SET lease_expires_at = now() - interval '1 second'`);

    const beat = await heartbeat(sql, 'agent-1', 2);

    expect([...beat.held].sort()).toEqual([a, b].sort());
    expect(beat.cancelling).toEqual([b]);
    expect(await statusOf(a)).toMatchObject({ leased: true });
    const runner = await db.query<{ busy: number }>(`SELECT busy FROM runners WHERE id = 'agent-1'`);
    expect(runner.rows[0].busy).toBe(2);
  });

  it('no longer returns a run the sweeper settled, which is how the agent learns to fence it', async () => {
    const id = await enqueue();
    await claimNextRun(sql, 'agent-1', 'default');
    await settleClaimedRun(sql, id, { status: 'failed', errorName: 'RunnerVanished', errorMessage: 'gone' });
    expect((await heartbeat(sql, 'agent-1', 1)).held).toEqual([]);
  });
});

describe('sweep', () => {
  it('settles a run whose lease expired, failed or cancelled as the user had asked', async () => {
    const running = await enqueue();
    const cancelling = await enqueue();
    await claimNextRun(sql, 'agent-1', 'default');
    await claimNextRun(sql, 'agent-1', 'default');
    await db.query(`UPDATE runs SET status = 'cancelling' WHERE id = $1`, [cancelling]);
    await db.query(`UPDATE runs SET lease_expires_at = now() - interval '1 second'`);

    const result = await sweep(sql);

    expect(result.swept).toBe(true);
    expect([...result.settledRuns].sort()).toEqual([running, cancelling].sort());
    expect(await statusOf(running)).toMatchObject({ status: 'failed', error_name: 'RunnerVanished' });
    expect(await statusOf(cancelling)).toMatchObject({ status: 'cancelled', error_name: 'RunnerVanished' });
  });

  it('leaves a run with a live lease, a queued run, and a run forked before 0004 alone', async () => {
    const leased = await enqueue();
    await claimNextRun(sql, 'agent-1', 'default');
    const queued = await enqueue();
    const legacy = await enqueue({ spec: false });
    await db.query(`UPDATE runs SET status = 'running', journal_path = '/j' WHERE id = $1`, [legacy]);

    expect((await sweep(sql)).settledRuns).toEqual([]);
    expect(await statusOf(leased)).toMatchObject({ status: 'running' });
    expect(await statusOf(queued)).toMatchObject({ status: 'queued' });
    expect(await statusOf(legacy)).toMatchObject({ status: 'running' });
  });

  it('shows a silent runner offline, and a heartbeat brings it back', async () => {
    await db.query(`UPDATE runners SET last_heartbeat_at = now() - interval '1 minute'`);
    expect((await sweep(sql)).offlineRunners).toEqual(['agent-1']);
    await heartbeat(sql, 'agent-1', 0);
    const { rows } = await db.query<{ state: string }>(`SELECT state FROM runners WHERE id = 'agent-1'`);
    expect(rows[0].state).toBe('online');
  });

  it('forgets a runner that has been offline for over a day', async () => {
    await registerRunner(sql, { id: 'gone', runnerClass: 'default', version: '1', slots: 1 });
    await db.query(`UPDATE runners SET state = 'offline', last_heartbeat_at = now() - interval '25 hours' WHERE id = 'gone'`);
    await sweep(sql);
    const { rows } = await db.query(`SELECT id FROM runners ORDER BY id`);
    expect(rows).toEqual([{ id: 'agent-1' }]);
  });

  it('deletes the spec of a run that settled without being claimed', async () => {
    const id = await enqueue();
    await db.query(`UPDATE runs SET status = 'failed' WHERE id = $1`, [id]);
    await sweep(sql);
    const { rows } = await db.query(`SELECT 1 FROM run_specs WHERE run_id = $1`, [id]);
    expect(rows).toEqual([]);
  });
});

describe('runner state announcements', () => {
  async function listen(): Promise<unknown[]> {
    const heard: unknown[] = [];
    await db.listen(RUNNERS_CHANNEL, (p) => heard.push(JSON.parse(p)));
    return heard;
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('announces a runner coming online and changing state, by class', async () => {
    const heard = await listen();
    await registerRunner(sql, { id: 'agent-2', runnerClass: 'large', version: '1', slots: 2 });
    await setRunnerState(sql, 'agent-2', 'draining');
    await settle();
    expect(heard).toEqual([{ runnerClass: 'large' }, { runnerClass: 'large' }]);
  });

  it('announces the runners the sweeper took offline, since a dead runner cannot', async () => {
    await db.query(`UPDATE runners SET last_heartbeat_at = now() - interval '1 minute'`);
    const heard = await listen();
    await sweep(sql);
    await settle();
    expect(heard).toEqual([{ runnerClass: 'default' }]);
  });

  it('announces nothing for an ordinary heartbeat, which happens every five seconds', async () => {
    const heard = await listen();
    await heartbeat(sql, 'agent-1', 0);
    await sweep(sql);
    await settle();
    expect(heard).toEqual([]);
  });
});

describe('reattachableRuns', () => {
  it('lists its own unsettled runs and ownerless ones from before 0004, never a queued run', async () => {
    const mine = await enqueue();
    await claimNextRun(sql, 'agent-1', 'default');
    await db.query(`UPDATE runs SET journal_path = '/mine', pid = 7 WHERE id = $1`, [mine]);
    const legacy = await enqueue({ spec: false });
    await db.query(`UPDATE runs SET status = 'running', journal_path = '/legacy' WHERE id = $1`, [legacy]);
    const theirs = await enqueue();
    await claimNextRun(sql, 'agent-2', 'default');
    await db.query(`UPDATE runs SET journal_path = '/theirs' WHERE id = $1`, [theirs]);
    await enqueue();

    const found = (await reattachableRuns(sql, 'agent-1')).map((r) => r.journalPath).sort();
    expect(found).toEqual(['/legacy', '/mine']);
  });
});
