import { createHash } from 'node:crypto';

export interface LockedDestination {
  readonly engine: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
}

/**
 * The key `runs_target_busy_uq` locks on: one run per destination database at
 * a time, across every org (docs/runner-service-plan.md, decision 5).
 *
 * Hashed so the column says nothing about where anyone's database lives, and
 * never serialised. The host is compared case-insensitively, as DNS does; the
 * database name exactly, since PostgreSQL's are case-sensitive. Two spellings
 * of one server (`localhost` and `127.0.0.1`, or an alias) are two keys — the
 * lock is a guard against the common mistake, not a proof of identity.
 */
export function targetLockKey(d: LockedDestination): string {
  const parts = [d.engine.toLowerCase(), d.host.trim().toLowerCase(), String(d.port), d.database];
  // NUL cannot occur in any of the four, so no two destinations share a preimage.
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}
