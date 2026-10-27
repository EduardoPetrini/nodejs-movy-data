import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { freshMetaDb } from '../../../../../packages/db/tests/helpers/meta-db';
import { PROBES_CHANNEL, PROBE_DONE_CHANNEL } from '../../../src/agent/channels';
import {
  abandonProbe,
  claimProbe,
  completeProbe,
  enqueueProbe,
  probeRunnerAvailable,
  takeProbeResult,
} from '../../../src/agent/probe-store';
import { registerRunner, setRunnerState, sweep, type SqlClient } from '../../../src/agent/queue-store';

/** Against PGlite with the real migrations, like the run queue's own tests. */
const ORG = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG = '22222222-2222-2222-2222-222222222222';

let db: PGlite;
let sql: SqlClient;

async function enqueue(opts: { runnerClass?: string; ttlMs?: number; orgId?: string } = {}): Promise<string> {
  const id = randomUUID();
  await enqueueProbe(sql, {
    id,
    orgId: opts.orgId ?? ORG,
    kind: 'test',
    runnerClass: opts.runnerClass ?? 'default',
    ciphertext: Buffer.from('sealed request'),
    ttlMs: opts.ttlMs ?? 60_000,
  });
  return id;
}

async function rowOf(id: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT status, runner_id, ciphertext IS NULL AS cleared, result FROM runner_probes WHERE id = $1`, [id]
  );
  return rows[0];
}

beforeEach(async () => {
  db = await freshMetaDb();
  sql = db as unknown as SqlClient;
  for (const [id, slug] of [[ORG, 'acme'], [OTHER_ORG, 'other']]) {
    await db.query(`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
  }
  await db.query(`INSERT INTO runner_classes (name, label) VALUES ('large', 'Large')`);
  await registerRunner(sql, { id: 'agent-1', runnerClass: 'default', version: '1', slots: 1 });
});

describe('probeRunnerAvailable', () => {
  it('is true for a class with an online runner that takes probes', async () => {
    expect(await probeRunnerAvailable(sql, 'default')).toBe(true);
  });

  it('is false for a class with no runner, a draining one, or one with no probe slots', async () => {
    expect(await probeRunnerAvailable(sql, 'large')).toBe(false);

    await setRunnerState(sql, 'agent-1', 'draining');
    expect(await probeRunnerAvailable(sql, 'default')).toBe(false);

    await registerRunner(sql, { id: 'agent-2', runnerClass: 'large', version: '1', slots: 1, probeSlots: 0 });
    expect(await probeRunnerAvailable(sql, 'large')).toBe(false);
  });

  it('registers two probe slots unless told otherwise', async () => {
    const { rows } = await db.query<{ probe_slots: number }>(`SELECT probe_slots FROM runners WHERE id = 'agent-1'`);
    expect(rows[0].probe_slots).toBe(2);
  });
});

describe('enqueue and claim', () => {
  it('wakes that class\'s runners in the same statement', async () => {
    const heard: unknown[] = [];
    await db.listen(PROBES_CHANNEL, (payload) => heard.push(JSON.parse(payload)));
    await enqueue({ runnerClass: 'large' });
    await expect.poll(() => heard).toEqual([{ runnerClass: 'large' }]);
  });

  it('hands the request to exactly one runner and clears it from the row at once', async () => {
    const id = await enqueue();

    const claimed = await claimProbe(sql, 'agent-1', 'default');
    expect(claimed).toEqual({ id, orgId: ORG, kind: 'test', ciphertext: Buffer.from('sealed request') });
    // The request holds passwords; nobody needs it twice.
    expect(await rowOf(id)).toMatchObject({ status: 'running', runner_id: 'agent-1', cleared: true });

    expect(await claimProbe(sql, 'agent-1', 'default')).toBeNull();
  });

  it('claims only its own class, oldest first', async () => {
    await enqueue({ runnerClass: 'large' });
    const first = await enqueue();
    const second = await enqueue();

    expect((await claimProbe(sql, 'agent-1', 'default'))?.id).toBe(first);
    expect((await claimProbe(sql, 'agent-1', 'default'))?.id).toBe(second);
    expect(await claimProbe(sql, 'agent-1', 'default')).toBeNull();
  });

  it('never claims a probe whose request has already given up', async () => {
    const id = await enqueue();
    await db.query(`UPDATE runner_probes SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await claimProbe(sql, 'agent-1', 'default')).toBeNull();
  });
});

describe('complete and take', () => {
  it('stores the result, notifies the waiting console, and gives the result up exactly once', async () => {
    const heard: unknown[] = [];
    await db.listen(PROBE_DONE_CHANNEL, (payload) => heard.push(JSON.parse(payload)));
    const id = await enqueue();
    await claimProbe(sql, 'agent-1', 'default');

    expect(await takeProbeResult(sql, id, ORG)).toBeNull();
    expect(await completeProbe(sql, id, { ok: true, latencyMs: 7 })).toBe(true);
    await expect.poll(() => heard).toEqual([{ id }]);

    expect(await takeProbeResult(sql, id, ORG)).toEqual({ ok: true, latencyMs: 7 });
    expect(await rowOf(id)).toBeUndefined();
    expect(await takeProbeResult(sql, id, ORG)).toBeNull();
  });

  it('never gives a result to another org, even holding the probe id', async () => {
    const id = await enqueue();
    await claimProbe(sql, 'agent-1', 'default');
    await completeProbe(sql, id, { ok: true, latencyMs: 1 });

    expect(await takeProbeResult(sql, id, OTHER_ORG)).toBeNull();
    expect(await takeProbeResult(sql, id, ORG)).toEqual({ ok: true, latencyMs: 1 });
  });

  it('completes nothing once the request has abandoned the probe', async () => {
    const id = await enqueue();
    await claimProbe(sql, 'agent-1', 'default');
    await abandonProbe(sql, id);
    expect(await completeProbe(sql, id, { ok: true, latencyMs: 1 })).toBe(false);
  });

  it('cannot complete a probe nobody claimed', async () => {
    const id = await enqueue();
    expect(await completeProbe(sql, id, { ok: true, latencyMs: 1 })).toBe(false);
  });
});

describe('sweep', () => {
  it('removes a probe whose request gave up, and leaves a live one', async () => {
    const stale = await enqueue();
    const live = await enqueue();
    await db.query(`UPDATE runner_probes SET expires_at = now() - interval '1 second' WHERE id = $1`, [stale]);

    await sweep(sql);

    expect(await rowOf(stale)).toBeUndefined();
    expect(await rowOf(live)).toMatchObject({ status: 'queued' });
  });
});
