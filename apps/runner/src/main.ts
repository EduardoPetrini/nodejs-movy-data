/**
 * Movy run driver.
 *
 * Forked once per migration run by the web app. Owns the process-level concerns
 * the core library must not: argv parsing, reading the spec off stdin, signal
 * handling, IPC framing, the event journal and exit codes.
 *
 * Two modes, one code path downstream of `emit`:
 *   --simulate <fixture>   replay a recorded journal, no database involved
 *   (default)              run a real migration from a spec on stdin
 *
 * That symmetry is deliberate. The web timeline, its projections and its socket
 * fan-out are built and exercised against simulated runs, and a real run then
 * needs no separate handling.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { composeSink, buildNeedles, redactString } from '@movy/core';
import type { MigrationEvent, RunTerminalStatus } from '@movy/core';
import { ArgsError, USAGE, parseRunnerArgs } from './args';
import type { RunnerArgs } from './args';
import { openJournal } from './journal';
import { RUNNER_EXIT, exitCodeForStatus, isHostToRunner } from './protocol';
import type { RunnerToHost } from './protocol';
import { RunSpecError, readRunSpec } from './run-spec';
import type { RunSpec } from './run-spec';
import { readJournalLines, replayJournal } from './simulate';
import { executeRun } from './execute';

/**
 * The run's two passwords as redaction needles, for the message paths that
 * never reach `composeSink`.
 *
 * Empty in simulate mode, where there is no spec and therefore no secret: a
 * replay reads a recorded fixture and opens no connection.
 */
function specNeedles(spec: RunSpec | 'invalid' | null): readonly string[] {
  if (spec === null || spec === 'invalid') return [];
  return buildNeedles([spec.source.password, spec.target.password]);
}

function send(message: RunnerToHost): void {
  // Two different "no channel" cases, and both are normal.
  //
  // `process.send` is absent when run from a shell rather than forked —
  // simulating from a terminal is a first-class way to use this.
  //
  // `process.connected` goes false when the HOST dies. `process.send` is still
  // there, so the optional call above does not cover it: Node emits an
  // unhandled 'error' on `process` and kills the runner. That would defeat the
  // whole point of the detached fork — the run is supposed to outlive the host
  // and be re-attached from the journal. The try/catch closes the race between
  // the check and the write.
  if (process.send === undefined || !process.connected) return;
  try {
    process.send(message);
  } catch {
    // The host went away mid-write. IPC is the copy; the journal has this
    // event already, and the host reads it back from there.
  }
}

async function main(): Promise<number> {
  let args: RunnerArgs;
  try {
    args = parseRunnerArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof ArgsError)) throw err;
    process.stderr.write(`movy-runner: ${err.message}\n\n${USAGE}\n`);
    return RUNNER_EXIT.usage;
  }

  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return RUNNER_EXIT.succeeded;
  }

  // Checked before anything is opened: naming a fixture that is not there is the
  // likeliest mistake with this command, and it is a usage error, not a crash.
  if (args.simulateFixture !== null && !fs.existsSync(args.simulateFixture)) {
    process.stderr.write(`movy-runner: fixture not found: ${args.simulateFixture}\n`);
    return RUNNER_EXIT.usage;
  }

  const spec = args.simulateFixture === null ? await loadSpec(args.stdinTimeoutMs) : null;
  if (spec === 'invalid') return RUNNER_EXIT.usage;

  const runId = spec?.runId ?? args.runId ?? randomUUID();

  // A holder rather than a plain `let`: the compiler cannot see that the error
  // callback runs, and would narrow a null-initialised local to `never`.
  const journalError: { current: Error | null } = { current: null };
  const journal = openJournal(args.journalPath, (err) => {
    journalError.current = err;
  });

  // Journal first, IPC second: the file is the record and the channel is a
  // best-effort copy of it. Reversing this would let the host acknowledge an
  // event that no restart could ever recover.
  const publish = (event: MigrationEvent): void => {
    journal.write(event);
    send({ k: 'event', event });
  };

  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  process.on('message', (message: unknown) => {
    if (isHostToRunner(message)) cancel();
  });

  send({ k: 'ready', runId, pid: process.pid, journalPath: journal.path });

  let status: RunTerminalStatus;
  let flush: (() => void) | null = null;

  try {
    if (args.simulateFixture !== null) {
      // Recorded events already carry seq, so they bypass composeSink entirely
      // — running them through a second SeqSink would renumber them.
      status = await replayJournal(readJournalLines(args.simulateFixture), {
        runId,
        speed: args.speed,
        emit: publish,
        signal: controller.signal,
      });
    } else {
      // The two passwords are the only secrets the runner holds, and this is
      // the one place that has both the spec and the sink. Everything
      // downstream — journal, IPC, socket — is fed from here, so scrubbing at
      // this seam covers all three without any of them knowing about it.
      const sink = composeSink(runId, publish, {
        secrets: [spec!.source.password, spec!.target.password],
      });
      flush = sink.flush;
      status = await executeRun(spec!, { emit: sink, signal: controller.signal });
    }
  } catch (err) {
    // The one message path that does NOT go through composeSink, and it lands in
    // the same two places a redacted one does: the host persists a fatal to
    // `runs.error_message`, which is served to viewers. `executeRun` currently
    // turns every migration error into a status rather than a throw, so nothing
    // credential-bearing reaches here today — but that is a property of a
    // function two files away, not something this seam guarantees for itself.
    const message = redactString(
      err instanceof Error ? err.message : String(err),
      specNeedles(spec)
    );
    process.stderr.write(`movy-runner: ${message}\n`);
    send({ k: 'fatal', runId, message });
    return RUNNER_EXIT.internal;
  } finally {
    // Drain the throttle's held progress sample so the last number in the
    // journal is the real one, then close. In `finally` because a run that
    // died still deserves its last recorded progress on the way out. The
    // flushed sample lands AFTER run_finished, which is expected: the host's
    // reducer takes the terminal status from the event, not from the last line.
    flush?.();
    await journal.close();
  }

  const journalFailure = journalError.current;
  if (journalFailure !== null) {
    // An fs error names a path, not a password — but this is the same fatal
    // frame, reaching the same persisted column, so it is scrubbed the same way
    // rather than relying on that staying true.
    const message = redactString(
      `journal write failed: ${journalFailure.message}`,
      specNeedles(spec)
    );
    process.stderr.write(`movy-runner: ${message}\n`);
    send({ k: 'fatal', runId, message });
    return RUNNER_EXIT.internal;
  }

  return exitCodeForStatus(status);
}

async function loadSpec(timeoutMs: number): Promise<RunSpec | 'invalid'> {
  try {
    return await readRunSpec(process.stdin, timeoutMs);
  } catch (err) {
    if (!(err instanceof RunSpecError)) throw err;
    process.stderr.write(`movy-runner: ${err.message}\n`);
    send({ k: 'fatal', runId: null, message: err.message });
    return 'invalid' as const;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
    // Closes the channel once queued messages have flushed. Without it an open
    // IPC handle keeps a finished runner alive indefinitely.
    //
    // Guarded like send(): disconnect() throws ERR_IPC_CHANNEL_CLOSED if the
    // host already went away, which would fall into the catch below and
    // overwrite a correct exit code with 70 — telling a host that the run
    // never started, when in fact it ran to completion after the host died.
    if (process.connected) {
      try {
        process.disconnect?.();
      } catch {
        // Already gone. The exit code is the record now.
      }
    }
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`movy-runner: unhandled failure\n${message}\n`);
    send({ k: 'fatal', runId: null, message: String(err) });
    process.exitCode = RUNNER_EXIT.internal;
  });
