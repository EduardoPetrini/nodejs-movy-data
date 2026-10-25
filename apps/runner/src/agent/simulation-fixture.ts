import * as fs from 'node:fs';
import * as path from 'node:path';

/** The recording a simulated run replays when nothing else is configured. */
export const BUNDLED_FIXTURE = 'pg-to-pg-315k.ndjson';

/**
 * The one recording a simulated run replays on this host, or undefined.
 *
 * Resolved by whoever runs the run — the embedded agent and the standalone one
 * alike — and never accepted from a request: this string becomes
 * `--simulate <path>` on a child process. `MOVY_SIMULATION_FIXTURE` wins; else
 * the recording shipped in `<runnerRoot>/fixtures`, if this host has it.
 */
export function resolveSimulationFixture(override: string | undefined, runnerRoot: string): string | undefined {
  if (override) return path.resolve(override);
  const bundled = path.join(runnerRoot, 'fixtures', BUNDLED_FIXTURE);
  return fs.existsSync(bundled) ? bundled : undefined;
}
