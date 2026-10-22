import { fork } from 'child_process';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { RunnerToHost } from '../../src/protocol';

/**
 * Forks the real binary the way the web app's RunManager will: detached, with
 * an IPC channel, replaying a fixture. Everything else in this suite tests a
 * module in isolation; this tests the contract the host actually depends on —
 * ready-then-events over IPC, cancel accepted, exit code matching the outcome.
 */
const ENTRY = path.resolve(__dirname, '../../src/main.ts');
const FIXTURE = path.resolve(__dirname, '../../fixtures/pg-to-pg-315k.ndjson');

let dir: string;
let child: ChildProcess | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movy-runner-'));
});

afterEach(() => {
  child?.kill('SIGKILL');
  child = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Outcome {
  readonly exitCode: number | null;
  readonly messages: RunnerToHost[];
  readonly journalPath: string;
}

function startRunner(args: readonly string[], onReady?: (proc: ChildProcess) => void): Promise<Outcome> {
  const journalPath = path.join(dir, 'run.ndjson');
  const proc = fork(ENTRY, ['--journal', journalPath, ...args], {
    // tsx resolves the core's `.js` specifiers back to its TypeScript sources.
    execArgv: ['--import', 'tsx'],
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child = proc;

  const messages: RunnerToHost[] = [];
  proc.on('message', (message) => {
    messages.push(message as RunnerToHost);
    if ((message as RunnerToHost).k === 'ready') onReady?.(proc);
  });

  return new Promise<Outcome>((resolve) => {
    proc.on('exit', (exitCode) => resolve({ exitCode, messages, journalPath }));
  });
}

describe('the runner process', () => {
  test('announces itself, streams events and exits 0 on a successful replay', async () => {
    const { exitCode, messages, journalPath } = await startRunner([
      '--simulate', FIXTURE, '--run-id', 'proc-ok', '--speed', '40',
    ]);

    expect(exitCode).toBe(0);

    const ready = messages[0];
    expect(ready).toMatchObject({ k: 'ready', runId: 'proc-ok', journalPath });
    expect(typeof (ready as { pid: number }).pid).toBe('number');

    const events = messages.filter((m) => m.k === 'event').map((m) => m.event);
    expect(events).toHaveLength(118);
    expect(events[0]!.type).toBe('run_started');
    expect(events.every((e) => e.runId === 'proc-ok')).toBe(true);

    // The journal is the record; IPC is a copy of it. They must agree.
    const journalled = fs.readFileSync(journalPath, 'utf8').trim().split('\n');
    expect(journalled).toHaveLength(118);
  }, 30_000);

  test('accepts a cancel over IPC and exits 2 with a cancelled terminal event', async () => {
    const { exitCode, messages, journalPath } = await startRunner(
      ['--simulate', FIXTURE, '--run-id', 'proc-cancel', '--speed', '0.2'],
      (proc) => setTimeout(() => proc.send({ k: 'cancel' }), 150)
    );

    expect(exitCode).toBe(2);

    const events = messages.filter((m) => m.k === 'event').map((m) => m.event);
    const terminal = events.at(-1)!;
    expect(terminal).toMatchObject({ type: 'run_finished', status: 'cancelled' });
    // The synthetic terminal continues the recorded numbering, so the host's
    // replay cursor stays gapless across a cancellation.
    expect(terminal.seq).toBe(events.length);

    const journalled = fs.readFileSync(journalPath, 'utf8').trim().split('\n');
    expect(JSON.parse(journalled.at(-1)!)).toMatchObject({ status: 'cancelled' });
  }, 30_000);

  test('exits 64 on bad argv without writing a journal', async () => {
    const { exitCode, messages, journalPath } = await startRunner([
      '--simulate', FIXTURE, '--speed', '40',
    ]);

    // --run-id is required with --simulate.
    expect(exitCode).toBe(64);
    expect(messages).toHaveLength(0);
    expect(fs.existsSync(journalPath)).toBe(false);
  }, 30_000);
});
