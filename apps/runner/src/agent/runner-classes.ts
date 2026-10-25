/**
 * Runner classes from the deploy-time file (docs/runner-service-plan.md,
 * decision 9): `MOVY_RUNNER_CLASSES_FILE`, JSON, validated, unknown keys
 * rejected. Phase 8 replaces the file with an admin screen; the table already
 * carries everything that screen edits.
 */

import type { SqlClient } from './queue-store';

export interface RunnerClassConfig {
  readonly name: string;
  readonly label: string;
  readonly description: string | null;
  readonly cpuMillis: number | null;
  readonly memoryMb: number | null;
  readonly maxReplicas: number;
  /** Suggest this class when the source is larger than this many bytes. */
  readonly suggestAboveBytes: number | null;
  readonly isDefault: boolean;
}

export class RunnerClassesFileError extends Error {
  override readonly name = 'RunnerClassesFileError';
}

/** Lowercase, short, and safe to print in a `docker compose` service name. */
const CLASS_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * `via: 'web'` on Test and Preview means the console itself, and is read as
 * that before any class is looked up: a class of this name could never be
 * chosen, and every test run on it would be recorded as the console's.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set(['web']);

/**
 * The one rule for a class name — the class file, `MOVY_RUNNER_CLASS` and a
 * saved definition all hold to it, so a name one accepts the others cannot
 * refuse later.
 */
export function isRunnerClassName(name: string): boolean {
  return CLASS_NAME.test(name) && !RESERVED_NAMES.has(name);
}

export const RUNNER_CLASS_NAME_RULE =
  'lowercase letters, digits and dashes, starting with a letter (at most 32), and not "web"';

/** Postgres `integer`, the type of `cpu_millis`, `memory_mb` and `max_replicas`. */
const INT4_MAX = 2_147_483_647;

const KEYS = new Set([
  'name', 'label', 'description', 'cpuMillis', 'memoryMb', 'maxReplicas', 'suggestAboveBytes', 'isDefault',
]);

function optionalCount(
  raw: Record<string, unknown>,
  key: string,
  at: string,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER
): number | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    // Checked here rather than left to the upsert, whose "out of range" names no field.
    throw new RunnerClassesFileError(
      max === Number.MAX_SAFE_INTEGER
        ? `${at}.${key} must be a whole number of at least ${min}.`
        : `${at}.${key} must be a whole number from ${min} to ${max}.`
    );
  }
  return value;
}

function parseClass(raw: unknown, at: string): RunnerClassConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RunnerClassesFileError(`${at} must be an object.`);
  }
  const entry = raw as Record<string, unknown>;
  // Rejected rather than ignored: a misspelt `suggestAboveByte` would otherwise
  // be a class that silently never gets suggested.
  const unknown = Object.keys(entry).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) throw new RunnerClassesFileError(`${at} has unknown keys: ${unknown.join(', ')}.`);

  const name = entry.name;
  if (typeof name !== 'string' || !isRunnerClassName(name)) {
    throw new RunnerClassesFileError(`${at}.name must be ${RUNNER_CLASS_NAME_RULE}.`);
  }
  const label = typeof entry.label === 'string' ? entry.label.trim() : '';
  if (label.length === 0 || label.length > 40) {
    throw new RunnerClassesFileError(`${at}.label is required, at most 40 characters.`);
  }
  if (entry.description !== undefined && entry.description !== null && typeof entry.description !== 'string') {
    throw new RunnerClassesFileError(`${at}.description must be a string.`);
  }
  if (entry.isDefault !== undefined && typeof entry.isDefault !== 'boolean') {
    throw new RunnerClassesFileError(`${at}.isDefault must be true or false.`);
  }

  return {
    name,
    label,
    description: typeof entry.description === 'string' && entry.description.trim() ? entry.description.trim() : null,
    cpuMillis: optionalCount(entry, 'cpuMillis', at, 1, INT4_MAX),
    memoryMb: optionalCount(entry, 'memoryMb', at, 1, INT4_MAX),
    maxReplicas: optionalCount(entry, 'maxReplicas', at, 0, INT4_MAX) ?? 1,
    suggestAboveBytes: optionalCount(entry, 'suggestAboveBytes', at, 1),
    isDefault: entry.isDefault === true,
  };
}

/**
 * The file's contents, or a `RunnerClassesFileError` naming the first thing
 * wrong with it and where. Exactly one class is the default: a run launched
 * without naming one has to go somewhere, and two answers is no answer.
 */
export function parseRunnerClassesFile(json: unknown): RunnerClassConfig[] {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new RunnerClassesFileError('The runner classes file must be an object with a "classes" array.');
  }
  const top = json as Record<string, unknown>;
  const extra = Object.keys(top).filter((k) => k !== 'classes');
  if (extra.length > 0) throw new RunnerClassesFileError(`Unknown top-level keys: ${extra.join(', ')}.`);
  if (!Array.isArray(top.classes) || top.classes.length === 0) {
    throw new RunnerClassesFileError('"classes" must be a non-empty array.');
  }

  const classes = top.classes.map((c, i) => parseClass(c, `classes[${i}]`));
  const seen = new Set<string>();
  for (const c of classes) {
    if (seen.has(c.name)) throw new RunnerClassesFileError(`Class "${c.name}" is listed twice.`);
    seen.add(c.name);
  }
  const defaults = classes.filter((c) => c.isDefault);
  if (defaults.length !== 1) {
    throw new RunnerClassesFileError(
      `Exactly one class must have "isDefault": true; ${defaults.length === 0 ? 'none does' : defaults.map((c) => c.name).join(' and ') + ' do'}.`
    );
  }
  return classes;
}

/**
 * Makes `runner_classes` say what the file says, in one statement.
 *
 * A class the file no longer names is never deleted — runs and definitions
 * point at it — but it is marked unconfigured and loses the default, so it is
 * listed as history and offered for nothing new.
 */
export async function upsertRunnerClasses(sql: SqlClient, classes: readonly RunnerClassConfig[]): Promise<void> {
  const rows = classes.map((c) => ({
    name: c.name,
    label: c.label,
    description: c.description,
    cpu_millis: c.cpuMillis,
    memory_mb: c.memoryMb,
    max_replicas: c.maxReplicas,
    suggest_above_bytes: c.suggestAboveBytes,
    is_default: c.isDefault,
  }));
  await sql.query(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         name text, label text, description text, cpu_millis integer, memory_mb integer,
         max_replicas integer, suggest_above_bytes bigint, is_default boolean)
     ),
     upserted AS (
       INSERT INTO runner_classes (name, label, description, cpu_millis, memory_mb, max_replicas,
                                   suggest_above_bytes, is_default, configured)
       SELECT name, label, description, cpu_millis, memory_mb, max_replicas, suggest_above_bytes, is_default, true
         FROM input
       ON CONFLICT (name) DO UPDATE SET
         label = excluded.label, description = excluded.description,
         cpu_millis = excluded.cpu_millis, memory_mb = excluded.memory_mb,
         max_replicas = excluded.max_replicas, suggest_above_bytes = excluded.suggest_above_bytes,
         is_default = excluded.is_default, configured = true, updated_at = now()
       RETURNING name
     )
     UPDATE runner_classes SET configured = false, is_default = false, updated_at = now()
      WHERE name NOT IN (SELECT name FROM input) AND (configured OR is_default)`,
    [JSON.stringify(rows)]
  );
}
