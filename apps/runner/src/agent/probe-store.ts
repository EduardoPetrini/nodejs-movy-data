/**
 * The probe queue, in SQL (docs/runner-service-plan.md, decision 6): Test and
 * Preview asked of a runner class. Same shape as the run queue — a row is the
 * job, `SKIP LOCKED` is the claim — but nothing here is durable on purpose: a
 * probe lives for one HTTP request, and the sweeper removes any whose request
 * gave up.
 */

import { PROBE_DONE_CHANNEL, PROBES_CHANNEL } from './channels';
import { interval, type SqlClient } from './queue-store';

export type ProbeKind = 'test' | 'preview';

export interface ClaimedProbe {
  readonly id: string;
  readonly orgId: string;
  readonly kind: ProbeKind;
  readonly ciphertext: Buffer;
}

export interface NewProbe {
  readonly id: string;
  readonly orgId: string;
  readonly kind: ProbeKind;
  readonly runnerClass: string;
  readonly ciphertext: Buffer;
  /** How long a runner may take to pick it up and answer. */
  readonly ttlMs: number;
}

/**
 * Whether any runner of the class would take a probe right now. Asked before
 * enqueuing, so "no runner of that class" is an immediate answer rather than a
 * timeout the user waits out.
 */
export async function probeRunnerAvailable(sql: SqlClient, runnerClass: string): Promise<boolean> {
  const { rows } = await sql.query(
    `SELECT 1 FROM runners WHERE class = $1 AND state = 'online' AND probe_slots > 0 LIMIT 1`,
    [runnerClass]
  );
  return rows.length > 0;
}

/** Inserts the probe and wakes that class's runners, in one statement. */
export async function enqueueProbe(sql: SqlClient, probe: NewProbe): Promise<void> {
  await sql.query(
    `WITH queued AS (
       INSERT INTO runner_probes (id, org_id, kind, runner_class, ciphertext, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + $6::interval)
       RETURNING runner_class
     )
     SELECT pg_notify('${PROBES_CHANNEL}', json_build_object('runnerClass', runner_class)::text) FROM queued`,
    [probe.id, probe.orgId, probe.kind, probe.runnerClass, probe.ciphertext, interval(probe.ttlMs)]
  );
}

/**
 * Claims the oldest live probe of the class. The request is cleared in the
 * same statement — it holds passwords, and only this runner needs it, once.
 */
export async function claimProbe(sql: SqlClient, runnerId: string, runnerClass: string): Promise<ClaimedProbe | null> {
  const { rows } = await sql.query<{ id: string; org_id: string; kind: ProbeKind; ciphertext: Buffer | Uint8Array }>(
    `WITH picked AS (
       SELECT id, ciphertext FROM runner_probes
        WHERE status = 'queued' AND runner_class = $2 AND expires_at > now() AND ciphertext IS NOT NULL
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE runner_probes p
        SET status = 'running', runner_id = $1, ciphertext = NULL
       FROM picked
      WHERE p.id = picked.id
     RETURNING p.id, p.org_id, p.kind, picked.ciphertext`,
    [runnerId, runnerClass]
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, orgId: row.org_id, kind: row.kind, ciphertext: Buffer.from(row.ciphertext) };
}

/**
 * Stores the result and tells the waiting console, in one statement. False when
 * the row is gone — the request timed out and deleted it — which is not an error.
 */
export async function completeProbe(sql: SqlClient, probeId: string, result: unknown): Promise<boolean> {
  const { rows } = await sql.query(
    `WITH done AS (
       UPDATE runner_probes SET status = 'done', result = $2::jsonb
        WHERE id = $1 AND status = 'running'
        RETURNING id
     )
     SELECT pg_notify('${PROBE_DONE_CHANNEL}', json_build_object('id', id)::text) FROM done`,
    [probeId, JSON.stringify(result)]
  );
  return rows.length > 0;
}

/**
 * The result, once, deleting the row as it is read; null while it is still
 * queued or running. Scoped to the org that asked, though the id alone is a
 * server-minted UUID.
 */
export async function takeProbeResult<T = unknown>(sql: SqlClient, probeId: string, orgId: string): Promise<T | null> {
  const { rows } = await sql.query<{ result: T }>(
    `DELETE FROM runner_probes WHERE id = $1 AND org_id = $2 AND status = 'done' RETURNING result`,
    [probeId, orgId]
  );
  return rows[0]?.result ?? null;
}

/** The request gave up. A runner still working on it finds no row to complete. */
export async function abandonProbe(sql: SqlClient, probeId: string): Promise<void> {
  await sql.query(`DELETE FROM runner_probes WHERE id = $1`, [probeId]);
}
