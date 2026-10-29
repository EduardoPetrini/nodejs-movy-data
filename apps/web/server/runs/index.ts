import * as os from 'node:os';
import { metaDatabaseUrl, useDb } from '../db/client';
import { runEvents, runs } from '../db/schema';
import { toPublicEvent } from '../serializers/run.serializer';
import { RunEventFeed } from './run-event-feed';
import { findSimulationFixture, journalPathFor, resolveRunnerEntry } from './host-paths';
import { configuredPlatformAdmins, platformAdminIds } from '../utils/platform-admin';
import { readEmbeddedRunnerConfig, type EmbeddedRunnerConfig } from './embedded-config';
import { RunnerHub, readRunnersGrant, type RunnersGrant } from '../runners/runner-hub';
import { loadRunnersSnapshot } from '../runners/runner-summary';
import { useProvisioner } from '../runners/use-provisioner';
import {
  EventWriter,
  RunManager,
  RUN_EVENTS_CHANNEL,
  RUNNERS_CHANNEL,
  PROBES_CHANNEL,
  PROBE_DONE_CHANNEL,
  RUNS_QUEUED_CHANNEL,
  RUN_CANCEL_CHANNEL,
  RUN_SETTLED_CHANNEL,
  PgListener,
  ProbeWorker,
  RunnerAgent,
  SUPPORTED_SPEC_VERSIONS,
  applyProjection,
  finaliseRunIfUnsettled,
  markRunLaunched,
  parseEventPointer,
  parseStringField,
  reattachableRuns,
  sqlAgentQueue,
  sqlProbeQueue,
  type SqlClient,
} from '@movy/runner/agent';
import { ProbeWaiters } from '../probes/probe-waiters';
import { RunHub, readSubscriptionGrant, type SubscriptionGrant } from './run-hub';
import { SettledStatusFeed } from './settled-status';
import { TicketStore } from './subscription-ticket';
import { memberships } from '../db/schema';
import { memberKey } from './run-hub';
import { and, asc, eq, gt, inArray, or } from 'drizzle-orm';

export { findSimulationFixture, journalPathFor, resolveRunnerEntry } from './host-paths';

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
let settledFeed: SettledStatusFeed | undefined;
let tickets: TicketStore<SubscriptionGrant> | undefined;

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

export function useTicketStore(): TicketStore<SubscriptionGrant> {
  tickets ??= new TicketStore({ sql: useMetaSql(), kind: 'runs', parse: readSubscriptionGrant });
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

/**
 * Statuses no event carries: `movy_run_settled`, and a re-read of every watched
 * run when LISTEN reconnects, since a notification sent meanwhile is gone.
 */
export function useSettledStatusFeed(): SettledStatusFeed {
  settledFeed ??= new SettledStatusFeed({
    hub: useRunHub(),
    loadStatuses: async (runIds) => {
      const rows = await useDb()
        .select({
          id: runs.id,
          status: runs.status,
          errorName: runs.errorName,
          errorMessage: runs.errorMessage,
          startedAt: runs.startedAt,
          finishedAt: runs.finishedAt,
        })
        .from(runs)
        .where(inArray(runs.id, [...runIds]));
      return rows.map((row) => ({
        id: row.id,
        status: row.status,
        error: row.errorMessage ? { name: row.errorName ?? 'Error', message: row.errorMessage } : null,
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
      }));
    },
    onError: (err, runId) => console.error(`[runs] settled status${runId ? ` for ${runId}` : ''}:`, err.message),
  });
  return settledFeed;
}

/** Runner availability for the org home and runs page. */
export function useRunnerHub(): RunnerHub {
  if (!runnerHub) {
    const sql = useMetaSql();
    runnerHub = new RunnerHub({
      load: (orgId, includeRunners) =>
        loadRunnersSnapshot(sql, orgId, { includeRunners, isOnDemand: (cls) => useProvisioner().isOnDemand(cls) }),
      resolveRole: resolveRoles,
      resolveOperators: (userIds) => platformAdminIds(sql, userIds, configuredPlatformAdmins()),
      onError: (err) => console.error('[runners] hub:', err.message),
    });
  }
  return runnerHub;
}

/** Its own kind: a run-stream ticket can never open the runners socket, nor the reverse. */
export function useRunnersTicketStore(): TicketStore<RunnersGrant> {
  runnersTickets ??= new TicketStore({ sql: useMetaSql(), kind: 'runners', parse: readRunnersGrant });
  return runnersTickets;
}

/**
 * The LISTEN connection behind the feed. Started by the `run-bus` plugin.
 * On every reconnect both feeds re-read — events past their cursors, settled
 * statuses of every watched run: NOTIFY has no replay.
 */
export function useBusListener(): PgListener {
  if (!listener) {
    const runFeed = useRunEventFeed();
    listener = new PgListener({
      connectionString: metaDatabaseUrl(),
      // The queued and cancel channels matter only to this host's embedded
      // agent, for a run launched or cancelled through another web replica.
      channels: embeddedConfig()
        ? [RUN_EVENTS_CHANNEL, RUN_SETTLED_CHANNEL, RUNNERS_CHANNEL, PROBES_CHANNEL, PROBE_DONE_CHANNEL, RUNS_QUEUED_CHANNEL, RUN_CANCEL_CHANNEL]
        : [RUN_EVENTS_CHANNEL, RUN_SETTLED_CHANNEL, RUNNERS_CHANNEL, PROBES_CHANNEL, PROBE_DONE_CHANNEL],
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
        if (channel === RUNS_QUEUED_CHANNEL) {
          void useRunnerAgent()?.wake();
          return;
        }
        if (channel === RUN_CANCEL_CHANNEL) {
          const runId = parseStringField(payload, 'runId');
          if (runId) void useRunnerAgent()?.cancel(runId);
          return;
        }
        if (channel === RUN_SETTLED_CHANNEL) {
          const runId = parseStringField(payload, 'runId');
          if (runId) void useSettledStatusFeed().announce(runId);
          return;
        }
        if (channel === PROBE_DONE_CHANNEL) {
          const id = parseStringField(payload, 'id');
          if (id) useProbeWaiters().notify(id);
          return;
        }
        if (channel !== RUN_EVENTS_CHANNEL) return;
        const pointer = parseEventPointer(payload);
        if (pointer) runFeed.notify(pointer.runId, pointer.lastSeq);
      },
      onConnected: () => {
        // NOTIFY has no replay: re-read what either kind of notification may
        // have carried while the connection was down.
        runFeed.resync();
        void useSettledStatusFeed().resync();
        useProbeWaiters().notifyAll();
        void useProbeWorker()?.wake();
        void useRunnerHub().refresh();
      },
      onError: (err) => console.warn('[runs] LISTEN connection lost, reconnecting:', err.message),
    });
  }
  return listener;
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
  const config = embeddedConfig();
  if (!config) return undefined;
  probeWorker ??= new ProbeWorker({
    queue: sqlProbeQueue(useMetaSql(), embeddedRunnerId(), config.runnerClass),
    slots: config.probeSlots,
    onError: (err, probeId) => console.error(`[probes] ${probeId ?? 'worker'}:`, err.message),
  });
  return probeWorker;
}

/**
 * Whether this web process runs an agent in-process.
 *
 * On unless `MOVY_EMBEDDED_RUNNER=false`, which a deployment with runner
 * services sets (Compose does: `runner-default`, `runner-large`). Turning it
 * off with no runner service running leaves every run queued — the UI says
 * so and offers to start one, and nothing is lost.
 */
export function isEmbeddedRunner(): boolean {
  return process.env.MOVY_EMBEDDED_RUNNER !== 'false';
}

let embedded: EmbeddedRunnerConfig | undefined;

/**
 * The embedded agent's class and slots, or null when it runs none: switched
 * off, or misconfigured — refused by the runner service's own rules, logged
 * once, and then off, rather than run on a default nobody chose.
 */
export function embeddedConfig(): (EmbeddedRunnerConfig & { ok: true }) | null {
  if (!isEmbeddedRunner()) return null;
  if (!embedded) {
    embedded = readEmbeddedRunnerConfig(process.env);
    if (!embedded.ok) console.error(`[runs] embedded runner off: ${embedded.message}`);
  }
  return embedded.ok ? embedded : null;
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
  const config = embeddedConfig();
  if (!config) return undefined;
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
        // No broadcast here: every batch commits a NOTIFY, and the feed below
        // delivers it — the same path an agent in another process uses.
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
        runnerClass: config.runnerClass,
        version: `spec-v${SUPPORTED_SPEC_VERSIONS.join(',')}`,
        slots: config.slots,
        probeSlots: config.probeSlots,
      }),
      control: manager,
      slots: config.slots,
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
 * Refuses a simulation up front when this host's own agent has no recording,
 * rather than queuing a run that can only fail. An external agent resolves its
 * own fixture, so without an embedded one there is nothing to check here.
 */
export function assertSimulationAvailable(): void {
  if (embeddedConfig() && !findSimulationFixture()) {
    throw createError({
      statusCode: 503,
      statusMessage: 'No simulation recording is available on this host.',
    });
  }
}
