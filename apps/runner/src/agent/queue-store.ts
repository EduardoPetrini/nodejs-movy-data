/**
 * The run queue, in SQL. `runs` is the queue (decision 1): a queued row is a
 * job, `FOR UPDATE SKIP LOCKED` is the claim, and the lease is a timestamp the
 * owning agent keeps pushing forward.
 *
 * Written against `SqlClient` rather than Drizzle because the claim is one
 * statement Drizzle cannot express, and because `pg.Pool` and PGlite both
 * already satisfy it — so the tests run this exact SQL, not a mock of it.
 */

import { RUNNERS_CHANNEL } from './channels';

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
  /** Probes it answers at once; 0 takes none. Default 2. */
  readonly probeSlots?: number;
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

/**
 * State changes announce themselves on `movy_runners`, in the same statement:
 * registering, draining, going offline. A heartbeat does not — it happens every
 * five seconds per runner, and the consoles refresh busy counts on their own.
 */
export async function registerRunner(sql: SqlClient, r: RunnerRegistration): Promise<void> {
  await sql.query(
    `WITH up AS (
       INSERT INTO runners (id, class, version, slots, probe_slots, busy, state, provisioned_by, started_at, last_heartbeat_at)
       VALUES ($1, $2, $3, $4, $6, 0, 'online', $5, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         class = excluded.class, version = excluded.version, slots = excluded.slots,
         probe_slots = excluded.probe_slots, busy = 0,
         state = 'online', provisioned_by = excluded.provisioned_by,
         started_at = now(), last_heartbeat_at = now()
       RETURNING class
     )
     SELECT pg_notify('${RUNNERS_CHANNEL}', json_build_object('runnerClass', class)::text) FROM up`,
    [r.id, r.runnerClass, r.version, r.slots, r.provisionedBy ?? null, r.probeSlots ?? 2]
  );
}

export async function setRunnerState(
  sql: SqlClient,
  runnerId: string,
  state: 'online' | 'draining' | 'offline'
): Promise<void> {
  await sql.query(
    // Offline means nothing running here: a drained agent's last heartbeat may still count a run.
    `WITH changed AS (UPDATE runners SET state = $2, busy = CASE WHEN $2 = 'offline' THEN 0 ELSE busy END
                        WHERE id = $1 RETURNING class)
     SELECT pg_notify('${RUNNERS_CHANNEL}', json_build_object('runnerClass', class)::text) FROM changed`,
    [runnerId, state]
  );
}

/** How many destination-lock collisions one claim tolerates before it gives up until the next wake. */
const MAX_CLAIM_ATTEMPTS = 5;

/** PostgreSQL's unique_violation — here, only ever `runs_target_busy_uq`. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

/**
 * Takes the oldest queued run of this class whose destination is free, or nothing.
 *
 * One statement: two agents racing for the same row cannot both win, and the
 * loser skips to the next row instead of waiting on the winner's lock. A run
 * cancelled while queued is no longer `queued`, so it can never be claimed.
 *
 * **One run per destination** (decision 5), whatever org or class holds it. The
 * claim skips a queued run whose `target_lock_key` a running run already holds,
 * so it waits — still `queued` — while younger runs to other databases go
 * ahead. Two agents claiming two such runs at the same instant both pass that
 * check, because neither sees the other's uncommitted claim; the partial unique
 * index `runs_target_busy_uq` refuses the second. A unique check waits for the
 * conflicting transaction, so by the time it is refused the winner's claim is
 * committed — and simply asking again skips that destination.
 */
export async function claimNextRun(
  sql: SqlClient,
  runnerId: string,
  runnerClass: string,
  leaseMs = DEFAULT_LEASE_MS
): Promise<ClaimedRun | null> {
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    try {
      const { rows } = await sql.query<{ id: string; org_id: string; simulated: boolean }>(
        `UPDATE runs SET status = 'running', runner_id = $1, claimed_at = now(),
                started_at = coalesce(started_at, now()), updated_at = now(),
                lease_expires_at = now() + $3::interval
          WHERE id = (SELECT q.id FROM runs q
                       WHERE q.status = 'queued' AND q.runner_class = $2
                         AND (q.target_lock_key IS NULL OR NOT EXISTS (
                               SELECT 1 FROM runs b
                                WHERE b.target_lock_key = q.target_lock_key
                                  AND b.status IN ('running', 'cancelling')))
                       ORDER BY q.created_at, q.id
                       FOR UPDATE OF q SKIP LOCKED
                       LIMIT 1)
          RETURNING id, org_id, simulated`,
        [runnerId, runnerClass, interval(leaseMs)]
      );
      const row = rows[0];
      return row ? { id: row.id, orgId: row.org_id, simulated: row.simulated } : null;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return null;
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
 * any forked before migration 0004, which have no owner at all — those were
 * forked by a web console, so only the embedded agent asks for them; a
 * standalone runner could only find their journals missing and settle them. Never a queued
 * run — that one is waiting for a claim, not for a process that died.
 */
export async function reattachableRuns(
  sql: SqlClient,
  runnerId: string,
  { includeOwnerless = true }: { includeOwnerless?: boolean } = {}
): Promise<{ id: string; pid: number | null; journalPath: string; lastSeq: number; leased: boolean }[]> {
  const { rows } = await sql.query<{ id: string; pid: number | null; journal_path: string; last_seq: number; leased: boolean }>(
    `SELECT id, pid, journal_path, last_seq, lease_expires_at IS NOT NULL AS leased FROM runs
      WHERE status IN ('running', 'cancelling') AND journal_path IS NOT NULL
        AND (runner_id = $1 OR ($2 AND runner_id IS NULL))`,
    [runnerId, includeOwnerless]
  );
  return rows.map((r) => ({ id: r.id, pid: r.pid, journalPath: r.journal_path, lastSeq: r.last_seq, leased: r.leased }));
}

/**
 * One pass of the sweeper, as ONE statement so its advisory lock is
 * transaction-scoped: only one web replica sweeps at a time, and a crash
 * mid-sweep cannot leave the lock held.
 *
 * - runners silent past `offlineAfterMs` are shown offline;
 * - runs whose lease expired are settled — `failed`, or `cancelled` if a user
 *   had already asked — with the partially-applied warning;
 * - the spec of any run that settled without being claimed is deleted;
 * - each runner taken offline is announced on `movy_runners`, since a dead
 *   runner cannot announce itself;
 * - a runner offline for a day is deleted: a rebuilt container comes back
 *   under a new hostname, so the old row would otherwise stay forever.
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
        RETURNING id, class
     ),
     announced AS (
       SELECT pg_notify('${RUNNERS_CHANNEL}', json_build_object('runnerClass', class)::text) FROM offline
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
     forgotten AS (
       DELETE FROM runners
        WHERE (SELECT ok FROM lock) AND state = 'offline'
          AND last_heartbeat_at < now() - interval '24 hours'
     ),
     specs AS (
       DELETE FROM run_specs s USING runs r
        WHERE (SELECT ok FROM lock) AND r.id = s.run_id
          AND r.status IN ('succeeded', 'failed', 'cancelled')
     ),
     -- A probe whose handler gave up (timed out, or the web process died).
     probes AS (
       DELETE FROM runner_probes WHERE (SELECT ok FROM lock) AND expires_at < now()
     )
     SELECT (SELECT ok FROM lock) AS swept,
            (SELECT count(*) FROM announced) AS announced,
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
