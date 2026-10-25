import * as fs from 'node:fs';
import * as path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a run's journal goes: one file per run id under `dir`, so a run is
 * recoverable knowing only its id.
 *
 * The id is a UUID generated server-side and is checked here anyway: this
 * string becomes a filesystem path, and a path built from a request-shaped
 * value is exactly the kind of thing that stops being a UUID one refactor later.
 */
export function journalPathIn(dir: string, runId: string): string {
  if (!UUID.test(runId)) throw new Error('runId must be a UUID');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${runId}.ndjson`);
}
