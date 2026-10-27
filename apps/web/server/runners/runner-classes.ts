import * as fs from 'node:fs';
import {
  parseRunnerClassesFile,
  upsertRunnerClasses,
  type SqlClient,
} from '@movy/runner/agent';

/** Matches the embedded agent's start retry. */
const SYNC_RETRY_MS = 5_000;

let synced: Promise<void> | undefined;
let retryTimer: NodeJS.Timeout | undefined;

/**
 * Applies `MOVY_RUNNER_CLASSES_FILE` to `runner_classes`, once per process.
 *
 * Memoised so the embedded agent can await it before registering under a
 * class the file defines. Never rejects: a broken file is reported loudly and
 * the table keeps what it had, because a console that will not boot over a
 * typo in its class list is worse than one with yesterday's classes.
 *
 * Only a SUCCESS is memoised, and a broken file. A failed upsert is the
 * meta-db still booting, and remembering it would leave a class the file adds
 * missing until the next restart — every runner registering under it refused
 * by its foreign key. So it is retried on its own timer (the console may run no
 * embedded agent to ask again), and the next caller tries too.
 */
export function ensureRunnerClasses(
  sql: SqlClient,
  file = process.env.MOVY_RUNNER_CLASSES_FILE,
  retryMs = SYNC_RETRY_MS
): Promise<void> {
  synced ??= syncRunnerClasses(sql, file, retryMs);
  return synced;
}

async function syncRunnerClasses(sql: SqlClient, file: string | undefined, retryMs: number): Promise<void> {
  if (!file) return;
  let classes: ReturnType<typeof parseRunnerClassesFile>;
  try {
    classes = parseRunnerClassesFile(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    // Retrying cannot fix a typo; the next deploy does.
    console.error(`[runners] runner classes NOT applied from ${file}:`, err instanceof Error ? err.message : err);
    return;
  }
  try {
    await upsertRunnerClasses(sql, classes);
    console.info(`[runners] ${classes.length} runner class(es) from ${file}: ${classes.map((c) => c.name).join(', ')}`);
  } catch (err) {
    console.error(
      `[runners] runner classes NOT applied from ${file} (${err instanceof Error ? err.message : err}); retrying in ${retryMs / 1000}s.`
    );
    synced = undefined;
    if (retryMs > 0 && !retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void ensureRunnerClasses(sql, file, retryMs);
      }, retryMs);
      retryTimer.unref?.();
    }
  }
}

/** For tests: forget the memoised sync and any pending retry. */
export function resetRunnerClassesSync(): void {
  synced = undefined;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
}

export interface ConfiguredClass {
  name: string;
  label: string;
  isDefault: boolean;
  suggestAboveBytes: number | null;
}

/** The classes a run may be sent to, default first. */
export async function listConfiguredClasses(sql: SqlClient): Promise<ConfiguredClass[]> {
  const { rows } = await sql.query<{ name: string; label: string; is_default: boolean; suggest_above_bytes: string | number | null }>(
    `SELECT name, label, is_default, suggest_above_bytes FROM runner_classes
      WHERE configured ORDER BY is_default DESC, name`
  );
  return rows.map((r) => ({
    name: r.name,
    label: r.label,
    isDefault: r.is_default,
    // bigint arrives as a string from pg; a class threshold fits a double exactly.
    suggestAboveBytes: r.suggest_above_bytes === null ? null : Number(r.suggest_above_bytes),
  }));
}

export type ClassChoice =
  | { ok: true; runnerClass: string }
  | { ok: false; statusCode: 400 | 422; message: string };

/**
 * Which class a run goes to: the one asked for, else the definition's, else
 * the default. Pure over the configured list, so every branch is tested.
 *
 * A class that is no longer configured is refused when asked for, but a
 * definition still naming one falls back to the default rather than making
 * the definition unlaunchable — the file changed, not the migration.
 */
export function chooseRunnerClass(
  configured: readonly ConfiguredClass[],
  requested: unknown,
  definitionClass: string | null
): ClassChoice {
  const names = new Set(configured.map((c) => c.name));
  if (requested !== undefined && requested !== null && requested !== '') {
    if (typeof requested !== 'string') return { ok: false, statusCode: 400, message: 'runnerClass must be a string.' };
    if (!names.has(requested)) {
      return { ok: false, statusCode: 422, message: `There is no runner class "${requested}" configured.` };
    }
    return { ok: true, runnerClass: requested };
  }
  if (definitionClass && names.has(definitionClass)) return { ok: true, runnerClass: definitionClass };
  const fallback = configured.find((c) => c.isDefault) ?? configured[0];
  if (!fallback) return { ok: false, statusCode: 422, message: 'No runner class is configured.' };
  return { ok: true, runnerClass: fallback.name };
}
