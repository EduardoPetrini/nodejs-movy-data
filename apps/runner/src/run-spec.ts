import { DatabaseType } from '@movy/core';
import type { ConnectionConfig, SslConfig } from '@movy/core';

/**
 * What the host asks the runner to do.
 *
 * Delivered on stdin as a single JSON line, NOT in argv: argv is world-readable
 * through `ps` on a shared host and this object carries two passwords. stdin is
 * closed by the host immediately after writing, so the secret exists only in
 * the two processes' memory and never touches the filesystem.
 */
export interface RunSpec {
  readonly runId: string;
  /**
   * Query mode is deliberately absent. It is PostgreSQL-to-PostgreSQL only and
   * emits no progress events, so a timeline built on it would be a blank box —
   * the web UI disables it with the reason shown instead of failing here.
   */
  readonly mode: 'full';
  readonly source: ConnectionConfig;
  readonly target: ConnectionConfig;
}

/**
 * Carries the offending FIELD PATH and never the offending VALUE. This message
 * is logged by the host and can end up in an event stream, and two of the
 * fields it validates are passwords.
 */
export class RunSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunSpecError';
  }
}

const ENGINES: readonly string[] = Object.values(DatabaseType);

export function parseRunSpec(raw: string): RunSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser's own message quotes the input, which may be a partial spec.
    throw new RunSpecError('run spec is not valid JSON');
  }

  const spec = requireObject(parsed, 'spec');
  const runId = requireString(spec.runId, 'spec.runId');
  const mode = requireString(spec.mode, 'spec.mode');
  if (mode !== 'full') {
    throw new RunSpecError(`spec.mode must be "full" (query mode is not runnable)`);
  }

  return {
    runId,
    mode,
    source: parseConnection(spec.source, 'spec.source'),
    target: parseConnection(spec.target, 'spec.target'),
  };
}

function parseConnection(value: unknown, path: string): ConnectionConfig {
  const raw = requireObject(value, path);
  const type = requireString(raw.type, `${path}.type`);
  if (!ENGINES.includes(type)) {
    throw new RunSpecError(`${path}.type is not a supported engine`);
  }

  const ssl = parseSsl(raw.ssl, `${path}.ssl`);
  const schema = raw.schema === undefined ? undefined : requireString(raw.schema, `${path}.schema`);

  // Every field is named explicitly rather than spread from `raw`, so an
  // unknown key in the payload cannot ride along into a driver's options.
  return {
    type: type as DatabaseType,
    host: requireString(raw.host, `${path}.host`),
    port: requirePort(raw.port, `${path}.port`),
    user: requireString(raw.user, `${path}.user`),
    // Empty is allowed: trusted-auth setups legitimately have no password.
    password: requireStringAllowingEmpty(raw.password, `${path}.password`),
    database: requireString(raw.database, `${path}.database`),
    ...(ssl === undefined ? {} : { ssl }),
    ...(schema === undefined ? {} : { schema }),
  };
}

function parseSsl(value: unknown, path: string): SslConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const reject = (value as { rejectUnauthorized?: unknown }).rejectUnauthorized;
    if (typeof reject !== 'boolean') {
      throw new RunSpecError(`${path}.rejectUnauthorized must be a boolean`);
    }
    return { rejectUnauthorized: reject };
  }
  throw new RunSpecError(`${path} must be a boolean or { rejectUnauthorized }`);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RunSpecError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  const str = requireStringAllowingEmpty(value, path);
  if (str.length === 0) throw new RunSpecError(`${path} must not be empty`);
  return str;
}

function requireStringAllowingEmpty(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new RunSpecError(`${path} must be a string`);
  return value;
}

function requirePort(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new RunSpecError(`${path} must be an integer between 1 and 65535`);
  }
  return value;
}

/**
 * Reads the whole of `stream` and parses it as a run spec.
 *
 * The timeout matters: the host writes the spec and closes stdin immediately,
 * so if EOF has not arrived the host died between fork and write. Without it a
 * detached runner would sit forever holding an open handle and no run.
 */
export function readRunSpec(
  stream: NodeJS.ReadableStream,
  timeoutMs: number
): Promise<RunSpec> {
  return new Promise<RunSpec>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      finish(() => reject(new RunSpecError(`no run spec on stdin within ${timeoutMs}ms`)));
    }, timeoutMs);
    // A pending timer must not be what keeps a finished process alive.
    timer.unref?.();

    const finish = (act: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      act();
    };

    const onData = (chunk: Buffer | string): void => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    };
    const onEnd = (): void => {
      finish(() => {
        try {
          resolve(parseRunSpec(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    };
    const onError = (err: Error): void => {
      finish(() => reject(new RunSpecError(`could not read run spec from stdin: ${err.message}`)));
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}
