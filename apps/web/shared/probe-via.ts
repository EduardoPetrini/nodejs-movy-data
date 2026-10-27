import type { RunnerClassSummary } from './runner-wire';

/** `'web'` — the console itself — or the name of a runner class. */
export type ProbeViaValue = string;

export const WEB_VIA: ProbeViaValue = 'web';

/**
 * Where a Test or Preview ran, for a person: "the console", or the class's
 * label. A class the console no longer lists keeps its name rather than
 * disappearing, because a recorded test is history.
 */
export function viaDisplay(via: string | null | undefined, classes: readonly Pick<RunnerClassSummary, 'name' | 'label'>[]): string {
  if (!via || via === WEB_VIA) return 'the console';
  const known = classes.find((c) => c.name === via);
  return `the ${known?.label ?? via} runner`;
}
