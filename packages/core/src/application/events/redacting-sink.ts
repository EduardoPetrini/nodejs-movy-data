import { MigrationEventInput } from '../../domain/types/events.types.js';
import { MigrationEventSink } from '../../domain/ports/event-sink.port.js';

/**
 * Replaces known secret values wherever they appear in an event.
 *
 * This is the NET, not the design. The design is that events carry progress and
 * never configuration — `SafeEndpoint` has engine and database and nothing
 * else, precisely so there is no field for a password to sit in. But two
 * strings on every event are written by code that has never heard of that rule:
 * `log.message` and the `message` of a `SerialisedError`. A driver that quotes
 * its DSN back at us on a failed handshake, or a future `logger.info` built by
 * interpolating a config, lands a password on a stream that read-only viewers
 * subscribe to. Redaction here means those become bugs in a log line rather
 * than credential disclosure.
 *
 * Placed inside SafeSink and outside everything else, so the throttle, the
 * sequencer, the journal, the IPC channel and the socket all see scrubbed
 * events and no consumer has to remember to scrub for itself.
 */
export const REDACTED = '«redacted»';

/**
 * Secrets shorter than this are not redacted.
 *
 * A two-character password appears inside ordinary words — "at", "in", a table
 * called "orders" — and redacting it would shred every message on the stream
 * while advertising, by the placement of the marks, exactly what the password
 * was. A net that destroys the timeline is worse than the hole it closes, and
 * the hole is bounded: the primary defence is still that no event has a field
 * for a credential.
 */
export const MIN_REDACTABLE_SECRET_LENGTH = 4;

/**
 * Builds the needle list: each secret plus its percent-encoded form, because a
 * credential that leaks usually leaks inside a URI (`postgres://u:p%40ss@h/db`)
 * where the raw value never appears.
 *
 * Longest first, so a secret that contains another secret is matched whole
 * rather than being half-consumed by the shorter one.
 */
export function buildNeedles(secrets: readonly string[]): string[] {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== 'string') continue;
    if (secret.length < MIN_REDACTABLE_SECRET_LENGTH) continue;
    needles.add(secret);
    const encoded = encodeURIComponent(secret);
    if (encoded.length >= MIN_REDACTABLE_SECRET_LENGTH) needles.add(encoded);
  }
  return [...needles].sort((a, b) => b.length - a.length);
}

/** Replaces every occurrence of every needle. Plain string search, never a regex. */
export function redactString(value: string, needles: readonly string[]): string {
  let out = value;
  for (const needle of needles) {
    if (out.includes(needle)) out = out.split(needle).join(REDACTED);
  }
  return out;
}

/**
 * Depth cap. An event is a shallow JSON tree — the deepest is `plan_ready`'s
 * plan at four levels — so anything beyond this is a cycle or a mistake, and
 * either way recursion must stop rather than overflow inside telemetry.
 */
const MAX_DEPTH = 12;

/** Returns a new value with secrets replaced; never mutates its input. */
export function redactValue<T>(value: T, needles: readonly string[], depth = 0): T {
  if (needles.length === 0) return value;
  if (depth > MAX_DEPTH) return value;

  if (typeof value === 'string') {
    return redactString(value, needles) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, needles, depth + 1)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      out[key] = redactValue(source[key], needles, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Wraps a sink so every event passing through it is scrubbed first.
 *
 * With no usable secrets the original event is forwarded untouched rather than
 * deep-copied: the common case in tests and in the CLI is an empty list, and
 * cloning every progress event to change nothing is pure cost.
 */
export function createRedactingSink(
  target: MigrationEventSink,
  secrets: readonly string[] = []
): MigrationEventSink {
  const needles = buildNeedles(secrets);
  if (needles.length === 0) return target;
  return (event: MigrationEventInput): void => {
    target(redactValue(event, needles));
  };
}
