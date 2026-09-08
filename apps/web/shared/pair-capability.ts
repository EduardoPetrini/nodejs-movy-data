/**
 * What a Pair can do, and — when it cannot do something — the sentence saying
 * why.
 *
 * In `shared/` for the same reason `run-wire.ts` is: both halves need it, and a
 * rule described twice will disagree eventually. Here that disagreement has a
 * particular shape — the UI would disable a control for one reason and the API
 * would refuse it for another, or worse, the UI would offer something the API
 * refuses. The plan's rule is that an unsupported combination is **disabled
 * with the reason shown, never a run that fails on its first step**, and that
 * is only achievable if one module owns both the decision and its wording.
 *
 * The capability facts themselves come from `GET /api/pairs`, which is
 * `listSupportedPairs()` in @movy/core. Nothing here hardcodes an engine's
 * support; it only interprets what that endpoint reports.
 */

/** One row of `GET /api/pairs` — the wire shape of core's `PairDescriptor`. */
export interface WirePair {
  source: string;
  target: string;
  status: 'done' | 'planned';
  supportsQueryMode: boolean;
  supportsCountValidation: boolean;
  supportsParallelWorkers: boolean;
}

export type RunMode = 'full' | 'query';

/** Available, or unavailable with a sentence a person can act on. */
export type Availability = { ok: true } | { ok: false; reason: string };

export const AVAILABLE: Availability = { ok: true };

const unavailable = (reason: string): Availability => ({ ok: false, reason });

export const ENGINE_LABELS: Record<string, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mssql: 'SQL Server',
  snowflake: 'Snowflake',
};

export function engineLabel(engine: string): string {
  return ENGINE_LABELS[engine] ?? engine;
}

/**
 * Why query mode is not launchable even where the Pair supports it.
 *
 * `MigrateQueryUseCase` takes no `MigrationRunContext` and emits nothing — not
 * `run_started`, not a step, not a row count. Driving it from here would give
 * the operator a timeline with nine hollow nodes that never move, and no way
 * to tell that from a run that has hung. The CLI prints its progress to a
 * terminal, so that is where it stays until the use case is made observable.
 */
export const QUERY_MODE_NOT_RUNNABLE =
  'Query mode cannot be launched from here yet: it reports no progress, so its ' +
  'timeline would stay blank for the whole run. Run it from the CLI instead ' +
  '(pnpm start, then migrate / query).';

/** Query mode casts both connections to PgConnection, so both ends must be PG. */
function queryModeIsPostgresOnly(source: string, target: string): Availability {
  return unavailable(
    `Query mode is ${engineLabel('postgres')} → ${engineLabel('postgres')} only: it streams ` +
      `through PostgreSQL's COPY at both ends. This route is ` +
      `${engineLabel(source)} → ${engineLabel(target)}.`
  );
}

export function findPair(
  pairs: readonly WirePair[],
  source: string | undefined,
  target: string | undefined
): WirePair | undefined {
  if (!source || !target) return undefined;
  return pairs.find((p) => p.source === source && p.target === target);
}

/**
 * The engines with no Adapter Set behind them.
 *
 * Derived from the Pair matrix rather than fetched separately: an engine is
 * implemented exactly when its own self-Pair is Done, because
 * `listSupportedPairs()` marks a Pair Planned when *either* end is
 * unregistered. One endpoint therefore answers both questions, and the two
 * answers cannot drift apart.
 */
export function plannedEngines(pairs: readonly WirePair[]): string[] {
  return pairs
    .filter((p) => p.source === p.target && p.status === 'planned')
    .map((p) => p.source);
}

export function engineAvailability(pairs: readonly WirePair[], engine: string): Availability {
  if (!plannedEngines(pairs).includes(engine)) return AVAILABLE;
  return unavailable(`${engineLabel(engine)} is planned, not yet implemented.`);
}

/** Whether this directional route can be migrated at all. */
export function pairAvailability(
  pairs: readonly WirePair[],
  source: string | undefined,
  target: string | undefined
): Availability {
  if (!source || !target) return unavailable('Choose a source and a destination.');

  // Naming the unimplemented engine is more use than naming the Pair: it tells
  // the operator which half of their choice to change.
  for (const engine of [source, target]) {
    const engineCheck = engineAvailability(pairs, engine);
    if (!engineCheck.ok) return engineCheck;
  }

  const pair = findPair(pairs, source, target);
  if (!pair) {
    return unavailable(`${engineLabel(source)} → ${engineLabel(target)} is not a known route.`);
  }
  if (pair.status !== 'done') {
    return unavailable(`${engineLabel(source)} → ${engineLabel(target)} is planned, not yet implemented.`);
  }
  return AVAILABLE;
}

/**
 * Whether a definition in this mode may be SAVED.
 *
 * Deliberately more permissive than `modeAvailability` below: a query
 * definition against a Pair that supports query mode is a legitimate thing to
 * record and then run from the CLI. Refusing to save it would make the `mode`
 * column a lie, and would lose the one place the SQL is written down.
 */
export function saveAvailability(
  pairs: readonly WirePair[],
  source: string | undefined,
  target: string | undefined,
  mode: RunMode
): Availability {
  const pairCheck = pairAvailability(pairs, source, target);
  if (!pairCheck.ok) return pairCheck;
  if (mode === 'full') return AVAILABLE;

  const pair = findPair(pairs, source, target)!;
  return pair.supportsQueryMode ? AVAILABLE : queryModeIsPostgresOnly(source!, target!);
}

/**
 * Whether a run in this mode can be LAUNCHED right now.
 *
 * Three distinct refusals, most specific last, because each suggests a
 * different fix: change the engine, change the mode, or use the CLI.
 */
export function modeAvailability(
  pairs: readonly WirePair[],
  source: string | undefined,
  target: string | undefined,
  mode: RunMode
): Availability {
  const saveCheck = saveAvailability(pairs, source, target, mode);
  if (!saveCheck.ok) return saveCheck;
  return mode === 'full' ? AVAILABLE : unavailable(QUERY_MODE_NOT_RUNNABLE);
}
