import { buildRegistry, type ConnectionConfig, type ConnectionFailureKind } from '@movy/core';
import { describeConnectionFailure } from './safe-error';

export const TEST_TIMEOUT_MS = 10_000;

/** The answer to pressing Test, wherever it ran. Failures are data, not throws. */
export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  /** Already scrubbed of this connection's password. */
  readonly error?: string;
  readonly errorKind?: ConnectionFailureKind;
}

/**
 * Open a connection, measure the round trip, close it.
 *
 * The one implementation behind both Test buttons, in the console and on a
 * runner, so "fails from `large`" and "fails from web" are the same sentence
 * about different networks. A bad password is a normal outcome of pressing
 * Test, so it is returned rather than thrown.
 */
export async function testConnection(
  config: ConnectionConfig,
  timeoutMs: number = TEST_TIMEOUT_MS
): Promise<ConnectionTestResult> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const connection = buildRegistry().get(config.type).createConnection(config);
    try {
      await Promise.race([
        connection.connect(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs / 1000}s`)), timeoutMs);
        }),
      ]);
      return { ok: true, latencyMs: Date.now() - startedAt };
    } finally {
      await connection.end().catch(() => {});
    }
  } catch (err) {
    const failure = describeConnectionFailure(err, config);
    return { ok: false, error: failure.text, errorKind: failure.kind, latencyMs: Date.now() - startedAt };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
