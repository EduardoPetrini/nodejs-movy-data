/**
 * Which runner class a migration of this size should use (decision 8: the
 * signal is the source's size in BYTES, not its row count — a million narrow
 * rows and a million rows of JSON are different jobs). Shared so the server
 * decides and the review screen words it from the same numbers.
 */

export interface SuggestibleClass {
  name: string;
  label: string;
  /** Suggested once the source is larger than this. Null: never suggested. */
  suggestAboveBytes: number | null;
}

export interface RunnerSuggestion {
  runnerClass: string;
  label: string;
  aboveBytes: number;
}

/**
 * The class whose threshold is the HIGHEST one the source exceeds — so with
 * `large` above 20 GB and `xlarge` above 200 GB, a 300 GB source gets
 * `xlarge`, not both. Null when the size is unknown or below every threshold.
 */
export function suggestRunnerClass(
  totalBytes: number | null,
  classes: readonly SuggestibleClass[]
): RunnerSuggestion | null {
  if (totalBytes === null) return null;
  let best: RunnerSuggestion | null = null;
  for (const c of classes) {
    if (c.suggestAboveBytes === null || totalBytes <= c.suggestAboveBytes) continue;
    if (!best || c.suggestAboveBytes > best.aboveBytes) {
      best = { runnerClass: c.name, label: c.label, aboveBytes: c.suggestAboveBytes };
    }
  }
  return best;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Decimal units, as disk vendors and cloud consoles quote them. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))} ${UNITS[unit]}`;
}

/** The review screen's hint. A hint only: the selector is never switched for the user. */
export function suggestionSentence(totalBytes: number, s: RunnerSuggestion): string {
  return `The source is ${formatBytes(totalBytes)}; the ${s.label} runner is recommended above ${formatBytes(s.aboveBytes)}.`;
}
