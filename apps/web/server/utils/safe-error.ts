import { buildNeedles, redactString, classifyConnectionError } from '@movy/core';
import type { ConnectionConfig, ConnectionFailureKind } from '@movy/core';

/**
 * The message of a driver error, with the connection's own password removed.
 *
 * Five handlers report a failed connection back to the caller as data rather
 * than as a 500 — Test, list databases, list tables, preview and compare — and
 * one of them (`recordTest`) also writes it to `connections.last_test_error`,
 * where it is served to viewers by `toPublicConnection`. The message comes from
 * a driver, so its contents are not ours to predict: several quote the DSN they
 * were handed when a handshake fails, and a DSN carries the password.
 *
 * Passing the configs rather than the row is deliberate. `toConnectionConfig`
 * is where a secret is decrypted, so a caller that has a plaintext password to
 * leak necessarily has the config to pass here.
 */
export function safeErrorMessage(
  err: unknown,
  ...configs: readonly (ConnectionConfig | null | undefined)[]
): string {
  const raw = err instanceof Error ? err.message : String(err);
  const needles = buildNeedles(
    configs.flatMap((config) => (config?.password ? [config.password] : []))
  );
  return redactString(raw, needles);
}

/**
 * A failed connection, described for a human and safe to send.
 *
 * Combines the two things the five handlers each used to do by hand and
 * differently: classify the failure, and strip the credential out of whatever
 * the driver said. `summary` says what to do about it, `detail` is the driver's
 * own words kept for the operator who wants to search for them, and `kind` is
 * what a client can branch on without parsing prose.
 */
export function describeConnectionFailure(
  err: unknown,
  ...configs: readonly (ConnectionConfig | null | undefined)[]
): { kind: ConnectionFailureKind; summary: string; detail: string; text: string } {
  const { kind, summary } = classifyConnectionError(err);
  const detail = safeErrorMessage(err, ...configs);
  return { kind, summary, detail, text: `${summary} The database said: ${detail}` };
}
