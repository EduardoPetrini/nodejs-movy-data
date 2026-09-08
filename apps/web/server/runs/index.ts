import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { useDb } from '../db/client';
import {
  applyProjection,
  finaliseRunIfUnsettled,
  findUnsettledRuns,
  markRunLaunched,
} from '../repositories/runs.repo';
import { EventWriter } from './event-writer';
import { RunHub } from './run-hub';
import { RunManager } from './run-manager';
import { TicketStore } from './subscription-ticket';
import { memberships } from '../db/schema';
import { memberKey } from './run-hub';
import { and, eq, or } from 'drizzle-orm';

let manager: RunManager | undefined;
let writer: EventWriter | undefined;
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
 * One manager per Nitro process, built lazily.
 *
 * Module-level rather than per-request: it owns IPC channels to live child
 * processes, which outlive any one request by definition.
 */
export function useRunManager(): RunManager {
  if (!manager) {
    const db = useDb();
    const runHub = useRunHub();
    writer = new EventWriter(
      { apply: (runId, projection) => applyProjection(db, runId, projection) },
      {
        onError: (err, runId) => console.error(`[runs] event write failed for ${runId}:`, err.message),
        // After the durable write, never before — see EventWriter.onFlushed.
        //
        // Converted to the SAME WireEvent shape the snapshot sends. An earlier
        // version published the raw MigrationEvent, so a client received
        // `{seq,type,at,level,payload}` on connect and a bare event afterwards
        // — and every live frame then blew up in the reducer.
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
        unsettledRuns: () => findUnsettledRuns(db),
      },
      writer,
      {
        runnerEntry: resolveRunnerEntry(),
        onError: (err, runId) => console.error(`[runs] runner error for ${runId}:`, err.message),
      }
    );
  }
  return manager;
}

export function useEventWriter(): EventWriter {
  useRunManager();
  return writer!;
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
 * The one recording the web app will replay.
 *
 * Resolved here rather than accepted from a request body: this string becomes
 * `--simulate <path>` on a child process, and a path from a client is a path
 * the client chose.
 */
export function simulationFixture(): string {
  const override = process.env.MOVY_SIMULATION_FIXTURE;
  if (override) return path.resolve(override);

  const bundled = path.resolve(process.cwd(), '../runner/fixtures/pg-to-pg-315k.ndjson');
  if (!fs.existsSync(bundled)) {
    throw createError({
      statusCode: 503,
      statusMessage: 'No simulation recording is available on this host.',
    });
  }
  return bundled;
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
