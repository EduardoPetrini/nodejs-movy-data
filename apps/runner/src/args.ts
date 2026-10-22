const DEFAULT_STDIN_TIMEOUT_MS = 10_000;

export interface RunnerArgs {
  /** Where the NDJSON journal is appended. The system of record; always required. */
  readonly journalPath: string;
  /** Fixture to replay instead of touching a database, or null for a real run. */
  readonly simulateFixture: string | null;
  /** Replay rate multiplier. 1 reproduces the recorded timing; 0.05 is 20x slower. */
  readonly speed: number;
  /** Required when simulating (there is no spec to take it from). */
  readonly runId: string | null;
  readonly stdinTimeoutMs: number;
  readonly help: boolean;
}

export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgsError';
  }
}

export const USAGE = `movy-runner — drives one migration run and journals its events.

Usage:
  movy-runner --journal <path> [--run-id <id>] < spec.json
  movy-runner --journal <path> --simulate <fixture.ndjson> --run-id <id> [--speed <n>]

Options:
  --journal <path>       NDJSON event journal to append to (required).
  --simulate <fixture>   Replay a recorded journal instead of connecting to a database.
  --speed <n>            Replay rate for --simulate. 1 = recorded timing (default),
                         2 = twice as fast, 0.05 = twenty times slower.
  --run-id <id>          Run identifier. Required with --simulate; otherwise taken
                         from the spec on stdin.
  --stdin-timeout <ms>   How long to wait for the spec on stdin (default ${DEFAULT_STDIN_TIMEOUT_MS}).
  --help                 Print this and exit.

The run spec is read from stdin as one JSON object, never from argv: argv is
readable by any user on the host through \`ps\`, and the spec carries passwords.`;

export function parseRunnerArgs(argv: readonly string[]): RunnerArgs {
  let journalPath: string | null = null;
  let simulateFixture: string | null = null;
  let runId: string | null = null;
  let speed = 1;
  let stdinTimeoutMs = DEFAULT_STDIN_TIMEOUT_MS;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // `pnpm run <script> -- --flag` forwards the separator verbatim.
    if (arg === '--') continue;
    const [flag, inlineValue] = splitFlag(arg);

    switch (flag) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--journal':
        journalPath = takeValue(argv, i, inlineValue, flag);
        if (inlineValue === null) i += 1;
        break;
      case '--simulate':
        simulateFixture = takeValue(argv, i, inlineValue, flag);
        if (inlineValue === null) i += 1;
        break;
      case '--run-id':
        runId = takeValue(argv, i, inlineValue, flag);
        if (inlineValue === null) i += 1;
        break;
      case '--speed':
        speed = parsePositiveNumber(takeValue(argv, i, inlineValue, flag), flag);
        if (inlineValue === null) i += 1;
        break;
      case '--stdin-timeout':
        stdinTimeoutMs = parsePositiveNumber(takeValue(argv, i, inlineValue, flag), flag);
        if (inlineValue === null) i += 1;
        break;
      default:
        throw new ArgsError(`unknown option "${flag}"`);
    }
  }

  if (help) {
    return { journalPath: '', simulateFixture: null, speed, runId, stdinTimeoutMs, help: true };
  }

  if (journalPath === null) throw new ArgsError('--journal is required');
  if (simulateFixture !== null && runId === null) {
    throw new ArgsError('--run-id is required with --simulate');
  }
  if (simulateFixture === null && argvHasSpeed(argv)) {
    throw new ArgsError('--speed only applies to --simulate');
  }

  return { journalPath, simulateFixture, speed, runId, stdinTimeoutMs, help: false };
}

function argvHasSpeed(argv: readonly string[]): boolean {
  return argv.some((arg) => splitFlag(arg)[0] === '--speed');
}

function splitFlag(arg: string): [string, string | null] {
  const eq = arg.indexOf('=');
  if (arg.startsWith('--') && eq !== -1) return [arg.slice(0, eq), arg.slice(eq + 1)];
  return [arg, null];
}

function takeValue(
  argv: readonly string[],
  index: number,
  inlineValue: string | null,
  flag: string
): string {
  const value = inlineValue ?? argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new ArgsError(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ArgsError(`${flag} must be a positive number`);
  }
  return value;
}
