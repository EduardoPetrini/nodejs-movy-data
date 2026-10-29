import * as os from 'node:os';
import * as path from 'node:path';
import { RUNNER_CLASS_NAME_RULE, isRunnerClassName } from './runner-classes';

/**
 * Everything a standalone runner agent reads from its environment, parsed once.
 *
 * Pure: it takes the environment as an argument, so every default and every
 * refusal is testable without starting a process. A bad value is refused at
 * boot, naming the variable — never silently replaced by a default, because an
 * agent with the wrong class or no key runs, claims a run, and fails it.
 */
export interface AgentConfig {
  /** The metadata database, as the least-privilege `movy_runner` role. */
  readonly databaseUrl: string;
  /** Stable across restarts of the same host, so it re-attaches to its own runs. */
  readonly runnerId: string;
  readonly runnerClass: string;
  readonly slots: number;
  readonly probeSlots: number;
  readonly journalDir: string;
  /** The recording a simulated run replays; undefined falls back to the bundled one. */
  readonly simulationFixture: string | undefined;
  /** How long a SIGTERM waits for live runs before the agent exits anyway. */
  readonly drainMs: number;
  /** Set when a provisioner started this agent; only such an agent exits when idle. */
  readonly provisionedBy: string | null;
  /** Idle time before a provisioned agent exits. Ignored without `provisionedBy`. */
  readonly idleExitMs: number;
  /**
   * Claims this agent makes before it stops claiming and exits once they have
   * settled; null is unlimited. 1 is Job mode: one Kubernetes Job, one run.
   */
  readonly maxRuns: number | null;
  /** Serves `/livez` and `/readyz` on this port when set; null listens on nothing. */
  readonly healthPort: number | null;
}

export class AgentConfigError extends Error {
  override readonly name = 'AgentConfigError';
}

export const DEFAULT_DRAIN_MS = 110_000;
export const DEFAULT_IDLE_EXIT_MS = 10 * 60_000;
const MAX_PORT = 65_535;

type Env = Readonly<Record<string, string | undefined>>;

export interface SlotConfig {
  readonly slots: number;
  readonly probeSlots: number;
}

/**
 * Both slot counts, by one rule for every agent: unset or empty is the
 * caller's default, anything else a valid count or an `AgentConfigError`.
 * The defaults differ by host — a runner service is sized per class, the
 * console's embedded agent shares a bigger box — the reading never does.
 */
export function readSlots(env: Env, defaults: SlotConfig): SlotConfig {
  return {
    slots: integer(env, 'MOVY_RUNNER_SLOTS', defaults.slots, 1),
    probeSlots: integer(env, 'MOVY_RUNNER_PROBE_SLOTS', defaults.probeSlots, 0),
  };
}

/** `MOVY_RUNNER_CLASS`, or `default`; refused when the class file could never define it. */
export function readRunnerClass(env: Env): string {
  const runnerClass = env.MOVY_RUNNER_CLASS || 'default';
  // The class file's rule: a name it could never define would pass here and
  // fail on the `runners.class` foreign key at registration instead.
  if (!isRunnerClassName(runnerClass)) {
    throw new AgentConfigError(`MOVY_RUNNER_CLASS must be ${RUNNER_CLASS_NAME_RULE}.`);
  }
  return runnerClass;
}

export function readAgentConfig(env: Env, hostname: string = os.hostname()): AgentConfig {
  const databaseUrl = env.MOVY_DATABASE_URL || env.NUXT_DATABASE_URL;
  if (!databaseUrl) throw new AgentConfigError('MOVY_DATABASE_URL is required: the metadata database this runner claims runs from.');
  // Checked here rather than on the first claim: without the key every spec
  // fails to open, and each claimed run would be failed one after another.
  if (!env.MOVY_ENCRYPTION_KEY && !env.NUXT_ENCRYPTION_KEY) {
    throw new AgentConfigError("MOVY_ENCRYPTION_KEY is required: the console's key, which seals every run spec.");
  }

  const runnerClass = readRunnerClass(env);
  const fixture = env.MOVY_SIMULATION_FIXTURE;
  return {
    databaseUrl,
    runnerId: env.MOVY_RUNNER_ID || hostname,
    runnerClass,
    ...readSlots(env, { slots: 1, probeSlots: 2 }),
    journalDir: path.resolve(env.MOVY_JOURNAL_DIR || path.join(os.tmpdir(), 'movy-journals')),
    simulationFixture: fixture ? path.resolve(fixture) : undefined,
    drainMs: integer(env, 'MOVY_RUNNER_DRAIN_MS', DEFAULT_DRAIN_MS, 0),
    provisionedBy: env.MOVY_RUNNER_PROVISIONED_BY || null,
    idleExitMs: integer(env, 'MOVY_RUNNER_IDLE_EXIT_MS', DEFAULT_IDLE_EXIT_MS, 1_000),
    maxRuns: optionalInteger(env, 'MOVY_RUNNER_MAX_RUNS', 1),
    healthPort: optionalInteger(env, 'MOVY_RUNNER_HEALTH_PORT', 1, MAX_PORT),
  };
}

/** Unset or empty is the default; anything else must be an integer at or above `min`. */
function integer(env: Env, name: string, fallback: number, min: number): number {
  return optionalInteger(env, name, min) ?? fallback;
}

/** Unset or empty is null; anything else must be an integer in `[min, max]`. */
function optionalInteger(env: Env, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `of at least ${min}` : `from ${min} to ${max}`;
    throw new AgentConfigError(`${name} must be an integer ${range}.`);
  }
  return n;
}
