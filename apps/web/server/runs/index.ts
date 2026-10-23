import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { useDb } from '../db/client';
import {
  EventWriter,
  RunManager,
  RunnerAgent,
  SUPPORTED_SPEC_VERSIONS,
  applyProjection,
  finaliseRunIfUnsettled,
  markRunLaunched,
  reattachableRuns,
  sqlAgentQueue,
  type SqlClient,
} from '@movy/runner/agent';
import { RunHub } from './run-hub';
import { TicketStore } from './subscription-ticket';
import { memberships } from '../db/schema';
import { memberKey } from './run-hub';
import { and, eq, or } from 'drizzle-orm';

let manager: RunManager | undefined;
let writer: EventWriter | undefined;
let agent: RunnerAgent | undefined;
let hub: RunHub | undefined;
let tickets: TicketStore | undefined;

/**
 * The socket fan-out. Built before the writer, because the writer broadcasts
 * into it on every successful flush.
 */
export function useRunHub(): RunHub {
  if (!hub) {
    const db = useDb();
    hub = new RunHub({
      // Read per check, never cached: a demotion has to take effect on a live
      // socket, not at the subscriber's next reconnect. One query for every
      // subscriber, which is what makes checking every few seconds affordable.
      resolveRole: async (pairs) => {
        const found = new Map<string, (typeof memberships.$inferSelect)['role']>();
        if (pairs.length === 0) return found;

        const rows = await db
          .select({ orgId: memberships.orgId, userId: memberships.userId, role: memberships.role })
          .from(memberships)
          .where(
            or(...pairs.map((p) => and(eq(memberships.orgId, p.orgId), eq(memberships.userId, p.userId))))
          );

        for (const row of rows) found.set(memberKey(row.orgId, row.userId), row.role);
        return found;
      },
      onError: (err) => console.error('[runs] hub:', err.message),
    });
  }
  return hub;
}

export function useTicketStore(): TicketStore {
  if (!tickets) tickets = new TicketStore();
  return tickets;
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
    const runHub = useRunHub();
    writer = new EventWriter(
      { apply: (runId, projection) => applyProjection(db, runId, projection) },
      {
        onError: (err, runId) => console.error(`[runs] event write failed for ${runId}:`, err.message),
        onTruncated: (runId, atSeq) =>
          console.warn(`[runs] ${runId} exceeded its log-event cap at seq ${atSeq}; later log lines are not stored.`),
        // After the durable write, never before — see EventWriter.onFlushed.
        //
        // Converted to the SAME WireEvent shape the snapshot sends. An earlier
        // version published the raw MigrationEvent, so a client received
        // `{seq,type,at,level,payload}` on connect and a bare event afterwards
        // — and every live frame then blew up in the reducer.
        //
        // Only an EMBEDDED agent can publish like this; an agent in its own
        // process needs the NOTIFY bus of phase 3 to reach the hub.
        onFlushed: (runId, projection) =>
          runHub.publish(
            runId,
            projection.events.map((e) => ({
              seq: e.seq,
              type: e.type,
              at: e.at.toISOString(),
              level: e.level,
              payload: e.payload as unknown as Record<string, unknown>,
            }))
          ),
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
        runnerClass: process.env.MOVY_RUNNER_CLASS || 'default',
        version: `spec-v${SUPPORTED_SPEC_VERSIONS.join(',')}`,
        slots: runnerSlots(),
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
