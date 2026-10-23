/**
 * The run queue, in SQL. `runs` is the queue (decision 1): a queued row is a
 * job, `FOR UPDATE SKIP LOCKED` is the claim, and the lease is a timestamp the
 * owning agent keeps pushing forward.
 *
 * Written against `SqlClient` rather than Drizzle because the claim is one
 * statement Drizzle cannot express, and because `pg.Pool` and PGlite both
 * already satisfy it — so the tests run this exact SQL, not a mock of it.
 */

/** What both `pg.Pool` and PGlite provide. */
export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface ClaimedRun {
  readonly id: string;
  readonly orgId: string;
  readonly simulated: boolean;
}

export interface SealedSpec {
  readonly specVersion: number;
  readonly ciphertext: Buffer;
}

export interface HeartbeatResult {
  /** Runs this agent still holds a lease on. Anything else it runs is fenced. */
  readonly held: readonly string[];
  /** Of those, the ones a user has asked to cancel. */
  readonly cancelling: readonly string[];
}

export interface RunnerRegistration {
  readonly id: string;
  readonly runnerClass: string;
  readonly version: string;
  readonly slots: number;
  readonly provisionedBy?: string | null;
}

export interface Settlement {
  readonly status: 'failed' | 'cancelled';
  readonly errorName: string;
  readonly errorMessage: string;
}

export interface SweepResult {
  /** False when another web replica holds the sweep this time round. */
  readonly swept: boolean;
  readonly offlineRunners: readonly string[];
  readonly settledRuns: readonly string[];
}

/** Thirty seconds: six missed heartbeats before a run is someone else's problem. */
export const DEFAULT_LEASE_MS = 30_000;

/** Twenty seconds of silence before a runner is shown offline. */
export const DEFAULT_OFFLINE_AFTER_MS = 20_000;

/**
 * Any constant works so long as nothing else in the database uses it; this one
 * spells "movy" in hex. Transaction-scoped, so it is released when the sweep's
 * single statement ends and nothing can leak it.
 */
const SWEEP_LOCK_KEY = 0x6d6f7679;

const RUNNER_VANISHED =
  'The runner executing this run stopped reporting, and the run may be partially applied. ' +
  'Movy has no resume: check the destination before running it again.';

export function interval(ms: number): string {
  return `${Math.max(0, Math.round(ms))} milliseconds`;
}

export async function registerRunner(sql: SqlClient, r: RunnerRegistration): Promise<void> {
  await sql.query(
    `INSERT INTO runners (id, class, version, slots, busy, state, provisioned_by, started_at, last_heartbeat_at)
     VALUES ($1, $2, $3, $4, 0, 'online', $5, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       class = excluded.class, version = excluded.version, slots = excluded.slots, busy = 0,
       state = 'online', provisioned_by = excluded.provisioned_by,
       started_at = now(), last_heartbeat_at = now()`,
    [r.id, r.runnerClass, r.version, r.slots, r.provisionedBy ?? null]
  );
}

export async function setRunnerState(
  sql: SqlClient,
  runnerId: string,
  state: 'online' | 'draining' | 'offline'
): Promise<void> {
  await sql.query(`UPDATE runners SET state = $2 WHERE id = $1`, [runnerId, state]);
}

/**
 * Takes the oldest queued run of this class, or nothing.
 *
 * One statement: two agents racing for the same row cannot both win, and the
 * loser skips to the next row instead of waiting on the winner's lock. A run
 * cancelled while queued is no longer `queued`, so it can never be claimed.
 */
export async function claimNextRun(
  sql: SqlClient,
  runnerId: string,
  runnerClass: string,
  leaseMs = DEFAULT_LEASE_MS
): Promise<ClaimedRun | null> {
  const { rows } = await sql.query<{ id: string; org_id: string; simulated: boolean }>(
    `UPDATE runs SET status = 'running', runner_id = $1, claimed_at = now(),
            started_at = coalesce(started_at, now()), updated_at = now(),
            lease_expires_at = now() + $3::interval
      WHERE id = (SELECT id FROM runs
                   WHERE status = 'queued' AND runner_class = $2
                   ORDER BY created_at, id
                   FOR UPDATE SKIP LOCKED
                   LIMIT 1)
      RETURNING id, org_id, simulated`,
    [runnerId, runnerClass, interval(leaseMs)]
  );
  const row = rows[0];
  return row ? { id: row.id, orgId: row.org_id, simulated: row.simulated } : null;
}

/**
 * Reads the sealed spec and deletes it in the same statement.
 *
 * Read once, never kept: there is no resume, so nothing needs the spec a second
 * time, and two database passwords are safer gone than sitting in a table.
 */
export async function takeRunSpec(sql: SqlClient, runId: string): Promise<SealedSpec | null> {
  const { rows } = await sql.query<{ spec_version: number; ciphertext: Buffer | Uint8Array }>(
    `DELETE FROM run_specs WHERE run_id = $1 RETURNING spec_version, ciphertext`,
    [runId]
  );
  const row = rows[0];
  return row ? { specVersion: row.spec_version, ciphertext: Buffer.from(row.ciphertext) } : null;
}

/**
 * The agent's one statement every few seconds: it is alive, this busy, and
 * still running these runs — whose leases move forward. The rows that come
 * back are the runs it still holds; a run missing from them was settled by
 * the sweeper, and the agent must stop it.
 */
export async function heartbeat(
  sql: SqlClient,
  runnerId: string,
  busy: number,
  leaseMs = DEFAULT_LEASE_MS
): Promise<HeartbeatResult> {
  const { rows } = await sql.query<{ id: string; status: string }>(
    `WITH beat AS (
       UPDATE runners SET last_heartbeat_at = now(), busy = $2,
              state = CASE WHEN state = 'offline' THEN 'online' ELSE state END
        WHERE id = $1
     )
     UPDATE runs SET lease_expires_at = now() + $3::interval
      WHERE runner_id = $1 AND status IN ('running', 'cancelling')
      RETURNING id, status`,
    [runnerId, busy, interval(leaseMs)]
  );
  return {
    held: rows.map((r) => r.id),
    cancelling: rows.filter((r) => r.status === 'cancelling').map((r) => r.id),
  };
}

/** Settles a run the agent claimed but could not start. Never overwrites an outcome. */
export async function settleClaimedRun(sql: SqlClient, runId: string, outcome: Settlement): Promise<boolean> {
  const { rows } = await sql.query(
    `UPDATE runs SET status = $2, error_name = $3, error_message = $4,
            finished_at = now(), updated_at = now()
      WHERE id = $1 AND status NOT IN ('succeeded', 'failed', 'cancelled')
      RETURNING id`,
    [runId, outcome.status, outcome.errorName, outcome.errorMessage]
  );
  return rows.length > 0;
}

/**
 * Cancels a run nobody has claimed yet. Conditional on `queued`, so it cannot
 * race a claim: exactly one of the two statements matches the row. False means
 * a runner has it, and the caller takes the running path.
 *
 * Takes the org id, unlike the agent's helpers: it is reached from a request,
 * through `RunsRepository`, and the org belongs in its WHERE clause.
 */
export async function cancelQueuedRun(sql: SqlClient, orgId: string, runId: string, userId: string): Promise<boolean> {
  const { rows } = await sql.query(
    `WITH cancelled AS (
       UPDATE runs SET status = 'cancelled', cancel_requested_at = now(),
              cancel_requested_by_user_id = $2, finished_at = now(), updated_at = now()
        WHERE id = $1 AND org_id = $3 AND status = 'queued'
        RETURNING id
     ), spec AS (
       DELETE FROM run_specs WHERE run_id IN (SELECT id FROM cancelled)
     )
     SELECT id FROM cancelled`,
    [runId, userId, orgId]
  );
  return rows.length > 0;
}

/**
 * Runs this agent may be able to re-attach to after a restart: its own, plus
 * any forked before migration 0004, which have no owner at all. Never a queued
 * run — that one is waiting for a claim, not for a process that died.
 */
export async function reattachableRuns(
  sql: SqlClient,
  runnerId: string
): Promise<{ id: string; pid: number | null; journalPath: string; lastSeq: number }[]> {
  const { rows } = await sql.query<{ id: string; pid: number | null; journal_path: string; last_seq: number }>(
    `SELECT id, pid, journal_path, last_seq FROM runs
      WHERE status IN ('running', 'cancelling') AND journal_path IS NOT NULL
        AND (runner_id = $1 OR runner_id IS NULL)`,
    [runnerId]
  );
  return rows.map((r) => ({ id: r.id, pid: r.pid, journalPath: r.journal_path, lastSeq: r.last_seq }));
}

/**
 * One pass of the sweeper, as ONE statement so its advisory lock is
 * transaction-scoped: only one web replica sweeps at a time, and a crash
 * mid-sweep cannot leave the lock held.
 *
 * - runners silent past `offlineAfterMs` are shown offline;
 * - runs whose lease expired are settled — `failed`, or `cancelled` if a user
 *   had already asked — with the partially-applied warning;
 * - the spec of any run that settled without being claimed is deleted.
 *
 * Runs with no lease at all (forked before 0004) are left to re-attach.
 */
export async function sweep(sql: SqlClient, offlineAfterMs = DEFAULT_OFFLINE_AFTER_MS): Promise<SweepResult> {
  const { rows } = await sql.query<{ swept: boolean; offline: string[] | null; settled: string[] | null }>(
    `WITH lock AS (SELECT pg_try_advisory_xact_lock(${SWEEP_LOCK_KEY}) AS ok),
     offline AS (
       UPDATE runners SET state = 'offline'
        WHERE (SELECT ok FROM lock) AND state <> 'offline'
          AND last_heartbeat_at < now() - $1::interval
        RETURNING id
     ),
     settled AS (
       UPDATE runs SET
              status = CASE WHEN status = 'cancelling' THEN 'cancelled' ELSE 'failed' END,
              error_name = 'RunnerVanished', error_message = $2,
              finished_at = now(), updated_at = now()
        WHERE (SELECT ok FROM lock) AND status IN ('running', 'cancelling')
          AND lease_expires_at < now()
        RETURNING id
     ),
     specs AS (
       DELETE FROM run_specs s USING runs r
        WHERE (SELECT ok FROM lock) AND r.id = s.run_id
          AND r.status IN ('succeeded', 'failed', 'cancelled')
     )
     SELECT (SELECT ok FROM lock) AS swept,
            (SELECT array_agg(id) FROM offline) AS offline,
            (SELECT array_agg(id) FROM settled) AS settled`,
    [interval(offlineAfterMs), RUNNER_VANISHED]
  );
  const row = rows[0];
  return {
    swept: Boolean(row?.swept),
    offlineRunners: row?.offline ?? [],
    settledRuns: (row?.settled ?? []).map(String),
  };
}
