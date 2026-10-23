import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { metaDatabaseUrl, useDb } from '../db/client';
import { runEvents, runs } from '../db/schema';
import { toPublicEvent } from '../serializers/run.serializer';
import { RunEventFeed } from './run-event-feed';
import { PgListener } from './pg-listener';
import { RunnerHub, type RunnersGrant } from '../runners/runner-hub';
import { loadRunnersSnapshot } from '../runners/runner-summary';
import {
  EventWriter,
  RunManager,
  RUN_EVENTS_CHANNEL,
  RUNNERS_CHANNEL,
  PROBES_CHANNEL,
  PROBE_DONE_CHANNEL,
  ProbeWorker,
  RunnerAgent,
  SUPPORTED_SPEC_VERSIONS,
  applyProjection,
  finaliseRunIfUnsettled,
  markRunLaunched,
  reattachableRuns,
  sqlAgentQueue,
  sqlProbeQueue,
  type SqlClient,
} from '@movy/runner/agent';
import { ProbeWaiters } from '../probes/probe-waiters';
import { RunHub } from './run-hub';
import { TicketStore } from './subscription-ticket';
import { memberships } from '../db/schema';
import { memberKey } from './run-hub';
import { and, asc, eq, gt, or } from 'drizzle-orm';

let manager: RunManager | undefined;
let writer: EventWriter | undefined;
let agent: RunnerAgent | undefined;
let probeWorker: ProbeWorker | undefined;
let probeWaiters: ProbeWaiters | undefined;
let feed: RunEventFeed | undefined;
let runnerHub: RunnerHub | undefined;
let runnersTickets: TicketStore<RunnersGrant> | undefined;
let listener: PgListener | undefined;
let hub: RunHub | undefined;
let tickets: TicketStore | undefined;

/** The socket fan-out for run streams. The event feed publishes into it. */
export function useRunHub(): RunHub {
  if (!hub) {
    hub = new RunHub({
      resolveRole: resolveRoles,
      onError: (err) => console.error('[runs] hub:', err.message),
    });
  }
  return hub;
}

/**
 * The CURRENT role of every subscriber, in one query. Read per check, never
 * cached: a demotion has to take effect on a live socket, not at the
 * subscriber's next reconnect. One query for every subscriber is what makes
 * checking every few seconds affordable. Shared by the run and runner hubs.
 */
async function resolveRoles(
  pairs: readonly { readonly orgId: string; readonly userId: string }[]
): Promise<Map<string, (typeof memberships.$inferSelect)['role']>> {
  const found = new Map<string, (typeof memberships.$inferSelect)['role']>();
  if (pairs.length === 0) return found;

  const rows = await useDb()
    .select({ orgId: memberships.orgId, userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(or(...pairs.map((p) => and(eq(memberships.orgId, p.orgId), eq(memberships.userId, p.userId)))));

  for (const row of rows) found.set(memberKey(row.orgId, row.userId), row.role);
  return found;
}

export function useTicketStore(): TicketStore {
  if (!tickets) tickets = new TicketStore();
  return tickets;
}

/**
 * Run events for the sockets on this host, from `run_events`, on NOTIFY.
 *
 * The cursor is fixed by `track()` when a peer joins — the socket handler
 * awaits it BEFORE reading that peer's snapshot — so live delivery starts no
 * later than the snapshot ends. See RunEventFeed for the ordering rules.
 */
export function useRunEventFeed(): RunEventFeed {
  if (!feed) {
    const db = useDb();
    const hub = useRunHub();
    feed = new RunEventFeed(
      {
        currentSeq: async (runId) => {
          const [row] = await db.select({ lastSeq: runs.lastSeq }).from(runs).where(eq(runs.id, runId)).limit(1);
          return row?.lastSeq ?? 0;
        },
        // Every cohort's events: the hub splits them into rooms, so a new event
        // type can never default into the wrong audience.
        readAfter: async (runId, afterSeq, limit) => {
          const rows = await db
            .select()
            .from(runEvents)
            .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
            .orderBy(asc(runEvents.seq))
            .limit(limit);
          return rows.map(toPublicEvent);
        },
        publish: (runId, events) => hub.publish(runId, events),
        isWatched: (runId) => hub.isWatching(runId),
      },
      { onError: (err, runId) => console.error(`[runs] event feed for ${runId}:`, err.message) }
    );
  }
  return feed;
}

/** Runner availability for the org home and runs page. */
export function useRunnerHub(): RunnerHub {
  if (!runnerHub) {
    const sql = useMetaSql();
    runnerHub = new RunnerHub({
      load: (orgId, includeRunners) => loadRunnersSnapshot(sql, orgId, { includeRunners }),
      resolveRole: resolveRoles,
      onError: (err) => console.error('[runners] hub:', err.message),
    });
  }
  return runnerHub;
}

/** Its own store: a run-stream ticket can never open the runners socket, nor the reverse. */
export function useRunnersTicketStore(): TicketStore<RunnersGrant> {
  if (!runnersTickets) runnersTickets = new TicketStore<RunnersGrant>();
  return runnersTickets;
}

/**
 * The LISTEN connection behind the feed. Started by the `run-bus` plugin.
 * On every reconnect the feed re-reads past its cursors: NOTIFY has no replay.
 */
export function useBusListener(): PgListener {
  if (!listener) {
    const runFeed = useRunEventFeed();
    listener = new PgListener({
      connectionString: metaDatabaseUrl(),
      channels: [RUN_EVENTS_CHANNEL, RUNNERS_CHANNEL, PROBES_CHANNEL, PROBE_DONE_CHANNEL],
      onNotification: (channel, payload) => {
        if (channel === RUNNERS_CHANNEL) {
          void useRunnerHub().refresh();
          return;
        }
        if (channel === PROBES_CHANNEL) {
          // Queued by any replica; this host's embedded worker may take it.
          void useProbeWorker()?.wake();
          return;
        }
        if (channel === PROBE_DONE_CHANNEL) {
          const id = parseProbePointer(payload);
          if (id) useProbeWaiters().notify(id);
          return;
        }
        if (channel !== RUN_EVENTS_CHANNEL) return;
        const pointer = parsePointer(payload);
        if (pointer) runFeed.notify(pointer.runId, pointer.lastSeq);
      },
      onConnected: () => {
        runFeed.resync();
        useProbeWaiters().notifyAll();
        void useProbeWorker()?.wake();
        void useRunnerHub().refresh();
      },
      onError: (err) => console.warn('[runs] LISTEN connection lost, reconnecting:', err.message),
    });
  }
  return listener;
}

/** A NOTIFY payload is data from the database, so it is checked rather than trusted. */
function parsePointer(payload: string): { runId: string; lastSeq: number } | null {
  try {
    const parsed = JSON.parse(payload) as { runId?: unknown; lastSeq?: unknown };
    if (typeof parsed.runId === 'string' && typeof parsed.lastSeq === 'number') {
      return { runId: parsed.runId, lastSeq: parsed.lastSeq };
    }
  } catch {
    // fall through: a malformed pointer is ignored, and the next one catches up
  }
  return null;
}

function parseProbePointer(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { id?: unknown };
    return typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

/** The requests on this host waiting for a probe's answer. */
export function useProbeWaiters(): ProbeWaiters {
  probeWaiters ??= new ProbeWaiters();
  return probeWaiters;
}

/**
 * The embedded agent's probe worker: answers Test and Preview asked of this
 * host's class. Undefined when this host runs no agent.
 */
export function useProbeWorker(): ProbeWorker | undefined {
  if (!isEmbeddedRunner()) return undefined;
  probeWorker ??= new ProbeWorker({
    queue: sqlProbeQueue(useMetaSql(), embeddedRunnerId(), embeddedRunnerClass()),
    slots: probeSlots(),
    onError: (err, probeId) => console.error(`[probes] ${probeId ?? 'worker'}:`, err.message),
  });
  return probeWorker;
}

/**
 * Whether this web process runs an agent in-process.
 *
 * On unless `MOVY_EMBEDDED_RUNNER=false`. Until the runner services of phase 6
 * (docs/runner-service-plan.md) exist, the embedded agent is the only thing
 * that claims runs, so turning it off without starting one leaves every run
 * queued — the UI says so, and nothing is lost.
 */
export function isEmbeddedRunner(): boolean {
  return process.env.MOVY_EMBEDDED_RUNNER !== 'false';
}

export function embeddedRunnerClass(): string {
  return process.env.MOVY_RUNNER_CLASS || 'default';
}

/** Stable across restarts of this host, so it re-attaches to its own runs. */
export function embeddedRunnerId(): string {
  return process.env.MOVY_RUNNER_ID || `embedded-${os.hostname()}`;
}

/** The SQL the queue, the sweeper and re-attach run, on the same pool Drizzle uses. */
export function useMetaSql(): SqlClient {
  return useDb().$client as unknown as SqlClient;
}

/**
 * The in-process runner agent, or undefined when this host runs none.
 *
 * Module-level rather than per-request: its RunManager owns IPC channels to
 * live child processes, which outlive any one request by definition.
 */
export function useRunnerAgent(): RunnerAgent | undefined {
  if (!isEmbeddedRunner()) return undefined;
  if (!agent) {
    const db = useDb();
    const sql = useMetaSql();
    const runnerId = embeddedRunnerId();
    writer = new EventWriter(
      { apply: (runId, projection) => applyProjection(db, runId, projection) },
      {
        onError: (err, runId) => console.error(`[runs] event write failed for ${runId}:`, err.message),
        onTruncated: (runId, atSeq) =>
          console.warn(`[runs] ${runId} exceeded its log-event cap at seq ${atSeq}; later log lines are not stored.`),
        // No onFlushed broadcast: every batch commits a NOTIFY, and the feed
        // below delivers it — the same path an agent in another process uses.
      }
    );

    manager = new RunManager(
      {
        markLaunched: (runId, info) => markRunLaunched(db, runId, info),
        finaliseIfUnsettled: (runId, outcome) => finaliseRunIfUnsettled(db, runId, outcome),
        unsettledRuns: () => reattachableRuns(sql, runnerId),
      },
      writer,
      {
        runnerEntry: resolveRunnerEntry(),
        onError: (err, runId) => console.error(`[runs] runner error for ${runId}:`, err.message),
        // Reported, not settled: a live-but-silent run must keep its
        // concurrency slot, or a second run launches into a destination the
        // first is still writing. See RunManager.follow().
        onStalled: (runId, silentMs) =>
          console.warn(
            `[runs] ${runId} has produced no events for ${Math.round(silentMs / 60_000)} minute(s) ` +
              'but its process is still alive. It may be blocked on a database lock.'
          ),
      }
    );

    agent = new RunnerAgent({
      queue: sqlAgentQueue(sql, {
        id: runnerId,
        runnerClass: embeddedRunnerClass(),
        version: `spec-v${SUPPORTED_SPEC_VERSIONS.join(',')}`,
        slots: runnerSlots(),
        probeSlots: probeSlots(),
      }),
      control: manager,
      slots: runnerSlots(),
      journalPathFor,
      simulationFixture: findSimulationFixture,
      onError: (err, runId) => console.error(`[runs] agent${runId ? ` (${runId})` : ''}:`, err.message),
      onFenced: (runId) =>
        console.warn(`[runs] ${runId} lost its lease and was stopped here; the sweeper had already settled it.`),
    });
  }
  return agent;
}

/** Closes the writer the embedded agent feeds, after the agent has stopped. */
export async function closeEventWriter(): Promise<void> {
  await writer?.close();
}

/**
 * Runs the embedded agent executes at once (`MOVY_RUNNER_SLOTS`, default 4).
 * The org's `max_concurrent_runs` is still the gate at launch; this is the
 * host's own limit, so one busy org cannot occupy every process on it.
 */
function runnerSlots(): number {
  const n = Number(process.env.MOVY_RUNNER_SLOTS);
  return Number.isInteger(n) && n > 0 ? n : 4;
}

/** Probes answered at once (`MOVY_RUNNER_PROBE_SLOTS`, default 2; 0 answers none). */
function probeSlots(): number {
  const raw = process.env.MOVY_RUNNER_PROBE_SLOTS;
  const n = Number(raw);
  // `Number('')` is 0, which would silently turn probes off.
  return raw && Number.isInteger(n) && n >= 0 ? n : 2;
}

/**
 * Where this run's journal goes.
 *
 * Under a directory, one file per run id, so a run is recoverable knowing only
 * its id. The id is a UUID generated server-side and is checked here anyway:
 * this string becomes a filesystem path, and a path built from a request-shaped
 * value is exactly the kind of thing that stops being a UUID one refactor later.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function journalPathFor(runId: string): string {
  if (!UUID.test(runId)) throw new Error('runId must be a UUID');
  const dir = process.env.MOVY_JOURNAL_DIR ?? path.resolve(process.cwd(), '.movy/runs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${runId}.ndjson`);
}

/**
 * The one recording a simulated run replays, on this host — or undefined.
 *
 * Resolved by whoever runs the run, never accepted from a request: this string
 * becomes `--simulate <path>` on a child process, and a path from a client is a
 * path the client chose.
 */
export function findSimulationFixture(): string | undefined {
  const override = process.env.MOVY_SIMULATION_FIXTURE;
  if (override) return path.resolve(override);
  const bundled = path.resolve(process.cwd(), '../runner/fixtures/pg-to-pg-315k.ndjson');
  return fs.existsSync(bundled) ? bundled : undefined;
}

/**
 * Refuses a simulation up front when this host's own agent has no recording,
 * rather than queuing a run that can only fail. An external agent resolves its
 * own fixture, so without an embedded one there is nothing to check here.
 */
export function assertSimulationAvailable(): void {
  if (isEmbeddedRunner() && !findSimulationFixture()) {
    throw createError({
      statusCode: 503,
      statusMessage: 'No simulation recording is available on this host.',
    });
  }
}

/**
 * Finds the runner binary.
 *
 * Prefers the built `dist/main.js` via package resolution. Falls back to the
 * TypeScript entry in the workspace, which `RunManager` loads through tsx — so
 * `pnpm dev:web` can start a run in a fresh clone without a build first, and
 * "click Run" never fails with a module-not-found nobody can act on.
 */
export function resolveRunnerEntry(): string {
  const override = process.env.MOVY_RUNNER_ENTRY;
  if (override) return path.resolve(override);

  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('@movy/runner');
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    // Not built, or resolution is unavailable in this bundle. Fall through.
  }

  const source = path.resolve(process.cwd(), '../runner/src/main.ts');
  if (fs.existsSync(source)) return source;

  throw new Error(
    '@movy/runner could not be located. Run `pnpm build`, or set MOVY_RUNNER_ENTRY.'
  );
}
