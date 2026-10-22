import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/**
 * The runner must outlive the host that forked it.
 *
 * That is the premise the whole design rests on: the journal is the system of
 * record precisely because a detached runner keeps writing while the web app
 * restarts, and the host re-attaches by reading the file forward. If the runner
 * dies with its parent, the journal is only ever as complete as the host's
 * uptime and the re-attach path is decoration.
 *
 * This is a REGRESSION test. It failed before the guards in `send()` and around
 * `process.disconnect()`: `process.send` still exists after the host dies —
 * only `process.connected` goes false — so an unguarded send made Node emit an
 * unhandled 'error' on `process` and kill the runner a few events in.
 */
const ENTRY = path.resolve(__dirname, '../../src/main.ts');
const FIXTURE = path.resolve(__dirname, '../../fixtures/pg-to-pg-315k.ndjson');
const FIXTURE_LINES = 118;

let dir: string;
let journalPath: string;
/** Lines present the moment the host exited — the orphan wrote everything after. */
let linesAtHostDeath = 0;
let reachedEnd = false;

/** A host that forks a detached runner exactly as RunManager does, then dies. */
function hostScript(journalPath: string, dieAfterMs: number): string {
  return `
    const { fork } = require('child_process');
    const child = fork(${JSON.stringify(ENTRY)}, [
      '--journal', ${JSON.stringify(journalPath)},
      '--simulate', ${JSON.stringify(FIXTURE)},
      '--run-id', '11111111-2222-3333-4444-555555555555',
      '--speed', '0.06',
    ], { detached: true, execArgv: ['--import', 'tsx'], stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
    child.stdin.end();
    child.unref();
    setTimeout(() => process.exit(0), ${dieAfterMs});
  `;
}

function lineCount(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0).length;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return predicate();
}

/**
 * One orphaned run, asserted from several angles. Forking a runner and waiting
 * out a replay is the expensive part; doing it per assertion would put half a
 * minute into every test run for no extra coverage.
 */
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movy-host-death-'));
  journalPath = path.join(dir, 'run.ndjson');

  const host = spawn(process.execPath, ['-e', hostScript(journalPath, 1200)], { stdio: 'ignore' });
  await new Promise<void>((resolve) => host.on('exit', () => resolve()));

  // The host is gone. Everything from here on is the orphan's own doing.
  linesAtHostDeath = lineCount(journalPath);
  reachedEnd = await waitFor(() => lineCount(journalPath) === FIXTURE_LINES, 25_000);
}, 40_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a runner whose host dies', () => {
  test('was still mid-run when the host exited', () => {
    // Otherwise the test proves nothing: a run that had already finished would
    // pass every assertion below without ever having been orphaned.
    expect(linesAtHostDeath).toBeGreaterThan(0);
    expect(linesAtHostDeath).toBeLessThan(FIXTURE_LINES);
  });

  test('keeps writing its journal and completes the run', () => {
    expect(reachedEnd, `journal stalled at ${lineCount(journalPath)} of ${FIXTURE_LINES} lines`).toBe(true);
  });

  test('records the terminal event, so re-attach can settle the run', () => {
    const events = fs
      .readFileSync(journalPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type: string; status?: string });

    const terminal = events.find((e) => e.type === 'run_finished');
    expect(terminal?.status).toBe('succeeded');
    // And it is not the last line: the throttle flushes a held progress sample
    // on close. Recovery must read the outcome from the event, not the tail.
    expect(events[events.length - 1].type).not.toBe('run_finished');
  });
});
