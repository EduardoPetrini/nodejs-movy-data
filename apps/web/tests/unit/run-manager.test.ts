import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { MigrationEvent } from '@movy/core';
import { RUNNER_EXIT } from '@movy/runner/protocol';
import { EventWriter } from '../../server/runs/event-writer';
import { RunManager } from '../../server/runs/run-manager';
import type { RunManagerStore } from '../../server/runs/run-manager';

type Unsettled = { id: string; pid: number | null; journalPath: string; lastSeq: number };

function fakeStore(unsettled: Unsettled[] = []) {
  const launched: { runId: string; pid: number; journalPath: string }[] = [];
  const settled: { runId: string; status: string; errorName?: string; errorMessage?: string }[] = [];
  const store: RunManagerStore = {
    async markLaunched(runId, info) { launched.push({ runId, ...info }); },
    async finaliseIfUnsettled(runId, outcome) { settled.push({ runId, ...outcome }); return true; },
    async unsettledRuns() { return unsettled; },
  };
  return { store, launched, settled };
}

/** A ChildProcess just real enough for the manager's contract. */
class FakeChild extends EventEmitter {
  pid = 4242;
  connected = true;
  stdin = { chunks: [] as string[], ended: false,
    write(c: string) { this.chunks.push(c); }, end() { this.ended = true; } };
  sent: unknown[] = [];
  unrefs = 0;
  send(message: unknown) { this.sent.push(message); return true; }
  unref() { this.unrefs += 1; }
  disconnect() { this.connected = false; }
}

function harness(unsettled: Unsettled[] = []) {
  const { store, launched, settled } = fakeStore(unsettled);
  const applied: { runId: string; events: MigrationEvent[] }[] = [];
  const writer = new EventWriter(
    { async apply(runId, projection) { applied.push({ runId, events: projection.events.map((e) => e.payload) }); } },
    { maxBatch: 1000, setTimer: () => 0 as unknown as NodeJS.Timeout, clearTimer: () => {} }
  );

  const children: FakeChild[] = [];
  const argvs: string[][] = [];
  const onError = vi.fn();
  const manager = new RunManager(store, writer, {
    runnerEntry: '/fake/runner/main.js',
    followIntervalMs: 20,
    onError,
    spawn: (_entry, argv) => {
      argvs.push(argv);
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
  });

  return { manager, writer, children, argvs, launched, settled, applied, onError };
}

const RUN_ID = '11111111-2222-3333-4444-555555555555';

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!predicate()) throw new Error('condition not met within timeout');
}

function finished(status: 'succeeded' | 'failed' | 'cancelled', seq = 9): MigrationEvent {
  return { type: 'run_finished', status, durationMs: 100, runId: RUN_ID, seq, at: new Date().toISOString() };
}

describe('RunManager.launch', () => {
  it('writes the spec to stdin and closes it, and never puts it in argv', async () => {
    const h = harness();
    h.manager.launch({ runId: RUN_ID, journalPath: '/tmp/j.ndjson', spec: { runId: RUN_ID, source: { password: 'hunter2' } } });

    const child = h.children[0];
    expect(child.stdin.chunks.join('')).toContain('hunter2');
    expect(child.stdin.ended).toBe(true);
    // `ps` is world-readable; a password in argv would be visible to every
    // user on the host.
    expect(h.argvs[0].join(' ')).not.toContain('hunter2');
    expect(h.argvs[0]).toEqual(['--journal', '/tmp/j.ndjson', '--run-id', RUN_ID]);
  });

  it('unrefs the child, so a host restart does not take the migration with it', () => {
    const h = harness();
    h.manager.launch({ runId: RUN_ID, journalPath: '/tmp/j.ndjson', spec: {} });
    expect(h.children[0].unrefs).toBe(1);
  });

  it('passes simulate flags and sends no spec in simulate mode', () => {
    const h = harness();
    h.manager.launch({
      runId: RUN_ID, journalPath: '/tmp/j.ndjson', spec: { secret: 'nope' },
      simulateFixture: '/f.ndjson', speed: 0.5,
    });

    expect(h.argvs[0]).toEqual(['--journal', '/tmp/j.ndjson', '--run-id', RUN_ID, '--simulate', '/f.ndjson', '--speed', '0.5']);
    expect(h.children[0].stdin.chunks).toEqual([]);
    expect(h.children[0].stdin.ended).toBe(true);
  });

  it('records pid and journal path from the ready message', async () => {
    const h = harness();
    h.manager.launch({ runId: RUN_ID, journalPath: '/tmp/j.ndjson', spec: {} });
    h.children[0].emit('message', { k: 'ready', runId: RUN_ID, pid: 999, journalPath: '/tmp/j.ndjson' });
    await Promise.resolve();

    expect(h.launched).toEqual([{ runId: RUN_ID, pid: 999, journalPath: '/tmp/j.ndjson' }]);
  });

  it('feeds events to the writer', async () => {
    const h = harness();
    h.manager.launch({ runId: RUN_ID, journalPath: '/tmp/j.ndjson', spec: {} });
    h.children[0].emit('message', {
      k: 'event',
      event: { type: 'log', level: 'info', message: 'hi', runId: RUN_ID, seq: 1, at: new Date().toISOString() },
    });
    await h.writer.flush();

    expect(h.applied).toHaveLength(1);
    expect(h.applied[0].runId).toBe(RUN_ID);
  });

  it('settles a fatal as failed — a fatal has no event stream to take an outcome from', async () => {
    const h = harness();
    h.manager.launch({ runId: RUN_ID, journalPath: '/tmp/j.ndjson', spec: {} });
    h.children[0].emit('message', { k: 'fatal', runId: RUN_ID, message: 'spec.source.port must be an integer' });
    await Promise.resolve();

    expect(h.settled[0]).toMatchObject({ runId: RUN_ID, status: 'failed', errorName: 'RunnerFatal' });
  });

  it('ignores a message that is not part of the protocol', async () => {
    const h = harness();
    h.manager.launch({ runId: RUN_ID, journalPath: '/tmp/j.ndjson', spec: {} });
    for (const junk of [null, 'string', 42, { k: 'cancel' }, { nope: true }]) {
      h.children[0].emit('message', junk);
    }
    await h.writer.flush();

    expect(h.applied).toHaveLength(0);
    expect(h.settled).toHaveLength(0);
  });
});

describe('RunManager — exit handling', () => {
  it('prefers the run_finished event over the exit code', async () => {
    const h = harness();
    h.manager.launch({ runId: RUN_ID, journalPath: '/tmp/j.ndjson', spec: {} });
    h.children[0].emit('message', { k: 'event', event: finished('succeeded') });
    h.children[0].emit('exit', RUNNER_EXIT.succeeded, null);
    await new Promise((r) => setImmediate(r));

    // The event carries the error and the duration; the exit code carries
    // neither, so it must not be the thing that settles the run.
    expect(h.settled).toHaveLength(0);
  });

  it('falls back to the exit code when the runner left without an outcome', async () => {
    for (const [code, status] of [
      [RUNNER_EXIT.succeeded, 'succeeded'],
      [RUNNER_EXIT.failed, 'failed'],
      [RUNNER_EXIT.cancelled, 'cancelled'],
    ] as const) {
      const h = harness();
      h.manager.launch({ runId: RUN_ID, journalPath: '/tmp/j.ndjson', spec: {} });
      h.children[0].emit('exit', code, null);
      await new Promise((r) => setImmediate(r));
      expect(h.settled[0]).toMatchObject({ runId: RUN_ID, status });
    }
  });

  it('reports a usage exit as a rejected specification', async () => {
    const h = harness();
    h.manager.launch({ runId: RUN_ID, journalPath: '/tmp/j.ndjson', spec: {} });
    h.children[0].emit('exit', RUNNER_EXIT.usage, null);
    await new Promise((r) => setImmediate(r));

    expect(h.settled[0]).toMatchObject({ status: 'failed', errorName: 'RunnerExited' });
    expect(h.settled[0].errorMessage).toContain('specification');
  });

  it('names the signal when one killed the runner', async () => {
    const h = harness();
    h.manager.launch({ runId: RUN_ID, journalPath: '/tmp/j.ndjson', spec: {} });
    h.children[0].emit('exit', null, 'SIGKILL');
    await new Promise((r) => setImmediate(r));

    expect(h.settled[0].errorMessage).toContain('SIGKILL');
  });

  it('flushes held events before settling, so the timeline is complete first', async () => {
    const h = harness();
    h.manager.launch({ runId: RUN_ID, journalPath: '/tmp/j.ndjson', spec: {} });
    h.children[0].emit('message', {
      k: 'event',
      event: { type: 'log', level: 'error', message: 'the last thing it said', runId: RUN_ID, seq: 1, at: new Date().toISOString() },
    });
    h.children[0].emit('exit', RUNNER_EXIT.failed, null);
    await new Promise((r) => setImmediate(r));

    expect(h.applied).toHaveLength(1);
    expect(h.settled).toHaveLength(1);
  });
});

describe('RunManager.cancel', () => {
  it('prefers IPC, so the runner aborts at a step boundary', async () => {
    const h = harness();
    h.manager.launch({ runId: RUN_ID, journalPath: '/tmp/j.ndjson', spec: {} });

    await expect(h.manager.cancel(RUN_ID, null)).resolves.toBe(true);
    expect(h.children[0].sent).toEqual([{ k: 'cancel' }]);
  });

  it('settles a run whose process is already gone instead of leaving the UI waiting', async () => {
    const h = harness();
    const signalled = await h.manager.cancel(RUN_ID, 2 ** 30);

    expect(signalled).toBe(false);
    expect(h.settled[0]).toMatchObject({ status: 'cancelled', errorName: 'RunnerGone' });
  });

  it('signals by pid a run this process never forked', async () => {
    const h = harness();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      // The normal case after a restart: the run is alive, the handle is not.
      await expect(h.manager.cancel(RUN_ID, process.pid)).resolves.toBe(true);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    } finally {
      kill.mockRestore();
    }
  });
});

describe('RunManager.reattach', () => {
  function journalOf(lines: unknown[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'movy-reattach-'));
    const path = join(dir, 'run.ndjson');
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
    return path;
  }

  it('replays only what is past the stored cursor and settles from the journal', async () => {
    const journalPath = journalOf([
      { type: 'log', level: 'info', message: 'a', runId: RUN_ID, seq: 1, at: new Date().toISOString() },
      { type: 'log', level: 'info', message: 'b', runId: RUN_ID, seq: 2, at: new Date().toISOString() },
      finished('succeeded', 3),
    ]);
    const h = harness([{ id: RUN_ID, pid: 2 ** 30, journalPath, lastSeq: 1 }]);

    const result = await h.manager.reattach();

    expect(result).toEqual({ recovered: 1, settled: 1, following: 0 });
    expect(h.applied[0].events.map((e) => e.seq)).toEqual([2, 3]);
    expect(h.settled[0]).toMatchObject({ status: 'succeeded' });
  });

  it('does not settle a still-running run, and follows it instead', async () => {
    const journalPath = journalOf([
      { type: 'log', level: 'info', message: 'still going', runId: RUN_ID, seq: 1, at: new Date().toISOString() },
    ]);
    // Its own pid: alive by construction, no terminal event in the journal.
    const h = harness([{ id: RUN_ID, pid: process.pid, journalPath, lastSeq: 0 }]);
    try {
      const result = await h.manager.reattach();
      expect(result).toEqual({ recovered: 1, settled: 0, following: 1 });
      expect(h.settled).toHaveLength(0);
    } finally {
      h.manager.shutdown();
    }
  });

  it('keeps reading an orphaned journal after boot, and settles when it ends', async () => {
    // The hole a one-shot read would leave: IPC died with the old host and can
    // never come back, so a run still in flight would go invisible until the
    // next boot unless the journal keeps being read.
    const journalPath = journalOf([
      { type: 'log', level: 'info', message: 'mid-copy', runId: RUN_ID, seq: 1, at: new Date().toISOString() },
    ]);
    const h = harness([{ id: RUN_ID, pid: process.pid, journalPath, lastSeq: 0 }]);

    try {
      expect((await h.manager.reattach()).following).toBe(1);

      // The orphan writes on, with nobody attached.
      appendFileSync(
        journalPath,
        '\n' +
          JSON.stringify({ type: 'log', level: 'info', message: 'still going', runId: RUN_ID, seq: 2, at: new Date().toISOString() }) +
          '\n' +
          JSON.stringify(finished('succeeded', 3))
      );

      await waitFor(() => h.settled.length > 0);

      expect(h.settled[0]).toMatchObject({ status: 'succeeded' });
      expect(h.applied.flatMap((a) => a.events.map((e) => e.seq))).toEqual([1, 2, 3]);
    } finally {
      h.manager.shutdown();
    }
  });

  it('stops following once a run has ended', async () => {
    const journalPath = journalOf([finished('succeeded', 1)]);
    const h = harness([{ id: RUN_ID, pid: process.pid, journalPath, lastSeq: 0 }]);

    expect((await h.manager.reattach()).following).toBe(0);

    // A finished run must not hold a poll timer for the life of the process.
    const before = h.applied.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(h.applied.length).toBe(before);
  });

  it('fails a run whose process vanished without an outcome, and says the state is partial', async () => {
    const journalPath = journalOf([
      { type: 'log', level: 'info', message: 'mid-copy', runId: RUN_ID, seq: 1, at: new Date().toISOString() },
    ]);
    const h = harness([{ id: RUN_ID, pid: 2 ** 30, journalPath, lastSeq: 0 }]);

    await h.manager.reattach();

    expect(h.settled[0]).toMatchObject({ status: 'failed', errorName: 'RunnerVanished' });
    // Movy has no resume; the operator must be told before they retry.
    expect(h.settled[0].errorMessage).toContain('partially applied');
  });

  it('settles a run whose journal was never written', async () => {
    const h = harness([{ id: RUN_ID, pid: 2 ** 30, journalPath: '/no/such/file.ndjson', lastSeq: 0 }]);

    const result = await h.manager.reattach();

    expect(result.recovered).toBe(0);
    expect(h.settled[0]).toMatchObject({ status: 'failed', errorName: 'RunnerVanished' });
  });

  it('takes the outcome from run_finished even when a flushed sample follows it', async () => {
    const journalPath = journalOf([
      finished('failed', 2),
      { type: 'overall_progress', rowsDone: 1, rowsTotal: 2, pct: 50, tablesDone: 0, tablesTotal: 1, runId: RUN_ID, seq: 3, at: new Date().toISOString() },
    ]);
    const h = harness([{ id: RUN_ID, pid: 2 ** 30, journalPath, lastSeq: 0 }]);

    await h.manager.reattach();

    expect(h.settled[0]).toMatchObject({ status: 'failed' });
  });

  it('keeps going when one journal cannot be read', async () => {
    const good = journalOf([finished('succeeded', 1)]);
    const h = harness([
      { id: RUN_ID, pid: 2 ** 30, journalPath: '/no/such/dir/x.ndjson', lastSeq: 0 },
      { id: '99999999-2222-3333-4444-555555555555', pid: 2 ** 30, journalPath: good, lastSeq: 0 },
    ]);

    const result = await h.manager.reattach();
    expect(result.settled).toBe(2);
  });
});

describe('RunManager.shutdown', () => {
  it('detaches from children without killing them', () => {
    const h = harness();
    h.manager.launch({ runId: RUN_ID, journalPath: '/tmp/j.ndjson', spec: {} });
    h.manager.shutdown();

    // The run is meant to outlive the host. Killing here would be the bug the
    // detached fork exists to prevent.
    expect(h.children[0].connected).toBe(false);
    expect(h.children[0].listenerCount('message')).toBe(0);
  });
});
