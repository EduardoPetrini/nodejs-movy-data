#!/usr/bin/env node
/**
 * movy-runner-agent: a runner agent as its own process (phase 6 of
 * docs/runner-service-plan.md).
 *
 * The same RunnerAgent, RunManager, EventWriter and ProbeWorker the web console
 * embeds, wired to the metadata database from the environment instead of from
 * Nuxt. It claims runs of one class, forks `main.js` beside it for each, and
 * answers Test and Preview for that class. Nothing reaches it but the database:
 * no port, no inbound connection, so a runner can sit wherever its databases are.
 *
 *   SIGTERM / SIGINT  drain: claim nothing more, wait up to MOVY_RUNNER_DRAIN_MS
 *                     for live runs, then exit 0. Never cancels a run.
 *   idle exit         only when MOVY_RUNNER_PROVISIONED_BY is set: a runner a
 *                     provisioner started leaves after MOVY_RUNNER_IDLE_EXIT_MS
 *                     with nothing to do. A baseline replica never does.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDb } from '@movy/db';
import {
  AgentConfigError,
  EventWriter,
  IdleWatch,
  PgListener,
  ProbeWorker,
  RUN_CANCEL_CHANNEL,
  RUNS_QUEUED_CHANNEL,
  PROBES_CHANNEL,
  RunManager,
  RunnerAgent,
  SUPPORTED_SPEC_VERSIONS,
  applyProjection,
  finaliseRunIfUnsettled,
  journalPathIn,
  markRunLaunched,
  readAgentConfig,
  reattachableRuns,
  sqlAgentQueue,
  sqlProbeQueue,
  type AgentConfig,
  type SqlClient,
} from './agent';
import { RUNNER_EXIT } from './protocol';

const START_RETRY_MS = 5_000;
const IDLE_CHECK_MS = 15_000;
const LOG_PREFIX = '[runner-agent]';

function log(level: 'info' | 'warn' | 'error', message: string): void {
  console[level](`${LOG_PREFIX} ${message}`);
}

function bundledFixture(): string | undefined {
  const bundled = path.resolve(__dirname, '../fixtures/pg-to-pg-315k.ndjson');
  return fs.existsSync(bundled) ? bundled : undefined;
}

/** `{runnerClass}` from the queued channel; anything unreadable wakes the agent anyway. */
function queuedFor(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { runnerClass?: unknown };
    return typeof parsed.runnerClass === 'string' ? parsed.runnerClass : null;
  } catch {
    return null;
  }
}

function cancelledRun(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { runId?: unknown };
    return typeof parsed.runId === 'string' ? parsed.runId : null;
  } catch {
    return null;
  }
}

async function run(config: AgentConfig): Promise<void> {
  // Every statement the agent runs is short. A timeout turns a query lost in a
  // network partition into an error the agent recovers from; without one it
  // waits forever, and a claim that never returns stops the agent claiming at
  // all — found by the Compose gate's partition step.
  const { pool, db } = createDb(config.databaseUrl, { max: 5, queryTimeoutMs: 30_000, connectTimeoutMs: 10_000 });
  // A dropped idle connection emits on the pool; unhandled, it kills the process.
  pool.on('error', (err) => log('warn', `meta-db connection lost: ${err.message}`));
  const sql = pool as unknown as SqlClient;

  const writer = new EventWriter(
    { apply: (runId, projection) => applyProjection(db, runId, projection) },
    {
      onError: (err, runId) => log('error', `event write failed for ${runId}: ${err.message}`),
      onTruncated: (runId, atSeq) =>
        log('warn', `${runId} exceeded its log-event cap at seq ${atSeq}; later log lines are not stored.`),
    }
  );

  const manager = new RunManager(
    {
      markLaunched: (runId, info) => markRunLaunched(db, runId, info),
      finaliseIfUnsettled: (runId, outcome) => finaliseRunIfUnsettled(db, runId, outcome),
      unsettledRuns: () => reattachableRuns(sql, config.runnerId, { includeOwnerless: false }),
    },
    writer,
    {
      runnerEntry: path.join(__dirname, 'main.js'),
      onError: (err, runId) => log('error', `runner error for ${runId}: ${err.message}`),
      onStalled: (runId, silentMs) =>
        log(
          'warn',
          `${runId} has produced no events for ${Math.round(silentMs / 60_000)} minute(s) ` +
            'but its process is still alive. It may be blocked on a database lock.'
        ),
    }
  );

  const agent = new RunnerAgent({
    queue: sqlAgentQueue(sql, {
      id: config.runnerId,
      runnerClass: config.runnerClass,
      version: `spec-v${SUPPORTED_SPEC_VERSIONS.join(',')}`,
      slots: config.slots,
      probeSlots: config.probeSlots,
      provisionedBy: config.provisionedBy,
    }),
    control: manager,
    slots: config.slots,
    journalPathFor: (runId) => journalPathIn(config.journalDir, runId),
    simulationFixture: () => config.simulationFixture ?? bundledFixture(),
    onError: (err, runId) => log('error', `${runId ? `(${runId}) ` : ''}${err.message}`),
    onFenced: (runId) => log('warn', `${runId} lost its lease and was stopped here.`),
  });

  const probes = new ProbeWorker({
    queue: sqlProbeQueue(sql, config.runnerId, config.runnerClass),
    slots: config.probeSlots,
    onError: (err, probeId) => log('error', `probe ${probeId ?? 'worker'}: ${err.message}`),
  });

  // The fast path for new work and cancels; the agent's own polls are the floor.
  const listener = new PgListener({
    connectionString: config.databaseUrl,
    channels: [RUNS_QUEUED_CHANNEL, RUN_CANCEL_CHANNEL, PROBES_CHANNEL],
    onNotification: (channel, payload) => {
      if (channel === RUN_CANCEL_CHANNEL) {
        const runId = cancelledRun(payload);
        if (runId) void agent.cancel(runId);
        return;
      }
      const forClass = queuedFor(payload);
      if (forClass !== null && forClass !== config.runnerClass) return;
      if (channel === RUNS_QUEUED_CHANNEL) void agent.wake();
      else void probes.wake();
    },
    onConnected: () => {
      void agent.wake();
      void probes.wake();
    },
    onError: (err) => log('warn', `LISTEN connection lost, reconnecting: ${err.message}`),
  });

  let stopping = false;
  let started = false;
  let idleTimer: NodeJS.Timeout | null = null;

  const shutdown = async (reason: string, drainMs: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (idleTimer) clearInterval(idleTimer);
    log('info', `${reason}: draining for up to ${Math.round(drainMs / 1000)}s.`);
    // Probes first: seconds long, and their requests are waiting on an answer.
    await probes.stop();
    if (started) await agent.drain(drainMs);
    await writer.close();
    await listener.stop();
    await pool.end().catch(() => undefined);
    log('info', 'stopped.');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM', config.drainMs));
  process.on('SIGINT', () => void shutdown('SIGINT', config.drainMs));

  log(
    'info',
    `${config.runnerId}: class ${config.runnerClass}, ${config.slots} run slot(s), ${config.probeSlots} probe slot(s)` +
      (config.provisionedBy ? `, provisioned by ${config.provisionedBy}` : '')
  );

  // Retried, never fatal: the meta-db may still be starting, or the console may
  // not have upserted this class from its class file yet.
  while (!stopping && !started) {
    try {
      await agent.start();
      started = true;
    } catch (err) {
      log('warn', `could not start (${err instanceof Error ? err.message : String(err)}); retrying in ${START_RETRY_MS / 1000}s.`);
      await new Promise((r) => setTimeout(r, START_RETRY_MS));
    }
  }
  if (stopping) return;
  probes.start();
  listener.start();
  log('info', 'online.');

  if (config.provisionedBy) {
    const idle = new IdleWatch(config.idleExitMs, Date.now());
    idleTimer = setInterval(() => {
      const busy = manager.liveRunIds().length + probes.busy;
      if (idle.observe(busy, Date.now())) void shutdown('idle', 0);
    }, IDLE_CHECK_MS);
  }
}

function main(): void {
  let config: AgentConfig;
  try {
    config = readAgentConfig(process.env);
  } catch (err) {
    if (!(err instanceof AgentConfigError)) throw err;
    process.stderr.write(`movy-runner-agent: ${err.message}\n`);
    process.exit(RUNNER_EXIT.usage);
  }
  run(config).catch((err: unknown) => {
    log('error', `fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(RUNNER_EXIT.internal);
  });
}

main();
