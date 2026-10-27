import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { freshMetaDb } from '../../../../packages/db/tests/helpers/meta-db';
import type { SqlClient } from '@movy/runner/agent';
import { loadQueueState } from '../../server/runs/queue-state';
import { queueSentence, queueStateOf, type QueueFacts } from '../../shared/queue-wire';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

let db: PGlite;
let sql: SqlClient;

async function run(org: string, opts: { status?: string; lockKey?: string; cls?: string; at?: string } = {}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO runs (id, org_id, source_engine, source_database, target_engine, target_database,
                       runner_class, status, target_lock_key, created_at)
     VALUES ($1, $2, 'postgres', 'a', 'postgres', 'b', $3, $4, $5, coalesce($6::timestamptz, now()))`,
    [id, org, opts.cls ?? 'default', opts.status ?? 'queued', opts.lockKey ?? null, opts.at ?? null]
  );
  return id;
}

async function runner(slots: number, busy: number, state = 'online') {
  await db.query(
    `INSERT INTO runners (id, class, version, slots, busy, state, started_at, last_heartbeat_at)
     VALUES ($1, 'default', '1', $2, $3, $4, now(), now())`,
    [randomUUID(), slots, busy, state]
  );
}

beforeEach(async () => {
  db = await freshMetaDb();
  sql = db as unknown as SqlClient;
  for (const [id, slug] of [[ORG_A, 'a'], [ORG_B, 'b']]) {
    await db.query(`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
  }
});

describe('loadQueueState', () => {
  it('says no runner when none of its class is online, even if another is draining', async () => {
    await runner(2, 0, 'draining');
    const id = await run(ORG_A);
    expect(await loadQueueState(sql, ORG_A, id)).toMatchObject({ reason: 'no_runner', runnerClass: 'default', classLabel: 'Default' });
  });

  it('says busy when every slot is taken, and counts only this org\'s runs ahead', async () => {
    await runner(2, 2);
    await run(ORG_A, { at: '2026-10-23T09:00:00Z' });
    await run(ORG_B, { at: '2026-10-23T09:00:01Z' });
    const id = await run(ORG_A, { at: '2026-10-23T09:00:02Z' });
    expect(await loadQueueState(sql, ORG_A, id)).toMatchObject({ reason: 'runners_busy', aheadInOrg: 1 });
  });

  it('names the run holding its destination when it is this org\'s', async () => {
    await runner(2, 1);
    const holder = await run(ORG_A, { status: 'running', lockKey: 'k' });
    const id = await run(ORG_A, { lockKey: 'k' });
    expect(await loadQueueState(sql, ORG_A, id)).toMatchObject({ reason: 'destination_busy', blockingRunId: holder });
  });

  it('does not name another org\'s run holding the destination', async () => {
    await runner(2, 1);
    await run(ORG_B, { status: 'cancelling', lockKey: 'k' });
    const id = await run(ORG_A, { lockKey: 'k' });
    expect(await loadQueueState(sql, ORG_A, id)).toMatchObject({ reason: 'destination_busy', blockingRunId: null });
  });

  it('says it is starting when nothing is in its way', async () => {
    await runner(1, 0);
    const id = await run(ORG_A, { lockKey: 'k' });
    expect(await loadQueueState(sql, ORG_A, id)).toMatchObject({ reason: 'starting' });
  });

  it('answers null for a run that is not queued, another org\'s run, and a malformed id', async () => {
    const running = await run(ORG_A, { status: 'running' });
    const other = await run(ORG_B);
    expect(await loadQueueState(sql, ORG_A, running)).toBeNull();
    expect(await loadQueueState(sql, ORG_A, other)).toBeNull();
    expect(await loadQueueState(sql, ORG_A, 'not-a-uuid')).toBeNull();
  });
});

describe('queueStateOf and queueSentence', () => {
  const facts: QueueFacts = {
    runnerClass: 'large', classLabel: 'Large', onlineRunners: 1, freeSlots: 1,
    aheadInOrg: 0, destinationHeld: false, blockingRunId: null,
  };

  it('puts no runner ahead of a busy destination, since only one of them resolves itself', () => {
    expect(queueStateOf({ ...facts, onlineRunners: 0, destinationHeld: true }).reason).toBe('no_runner');
    expect(queueStateOf({ ...facts, freeSlots: 0, destinationHeld: true }).reason).toBe('destination_busy');
  });

  it('only carries the blocking run when the destination is the reason', () => {
    expect(queueStateOf({ ...facts, onlineRunners: 0, destinationHeld: true, blockingRunId: 'x' }).blockingRunId).toBeNull();
  });

  it('words each reason for the run page', () => {
    expect(queueSentence(queueStateOf({ ...facts, onlineRunners: 0 }))).toBe(
      'Waiting for a runner: no Large runner is online. It starts as soon as one is.'
    );
    expect(queueSentence(queueStateOf({ ...facts, freeSlots: 0, aheadInOrg: 2 }))).toBe(
      'Waiting for a free slot: every Large runner is busy. 2 of this organization\'s runs are ahead of it.'
    );
    expect(queueSentence(queueStateOf({ ...facts, destinationHeld: true }))).toBe(
      'Waiting for the destination: another run is writing to the same database.'
    );
    expect(queueSentence(queueStateOf(facts))).toBe('Starting: a Large runner is picking it up.');
  });
});
