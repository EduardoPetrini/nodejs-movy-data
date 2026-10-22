import type { PageCursor } from '../../shared/keyset-cursor';

/**
 * The half of keyset pagination that both ledgers share.
 *
 * The cursor's encoding lives in `shared/keyset-cursor.ts` because the client
 * hands it back; this is the part only the server needs — how a page is
 * trimmed, and what "the next cursor" means. One copy, so "one page" means
 * the same thing on the run ledger and the comparison ledger.
 */

export function clampLimit(limit: number | undefined, fallback = 25, max = 100): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return fallback;
  return Math.min(Math.floor(limit), max);
}

export interface Page<T> {
  rows: T[];
  nextCursor: PageCursor | undefined;
}

/**
 * Trim the sentinel row and turn the page into its next cursor.
 *
 * The query asks for `limit + 1` so that "is there another page?" is answered
 * by the rows themselves rather than by a second COUNT over the whole table —
 * which on a ledger with a live run inserting into it would not agree with the
 * page anyway.
 *
 * The cursor always names the LAST ROW RETURNED, never the extra one fetched to
 * prove there is more. Naming the extra row would skip it.
 */
export function toPage<T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => { id: string; createdAt: Date }
): Page<T> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  if (!hasMore || !last) return { rows: page, nextCursor: undefined };

  const key = keyOf(last);
  return { rows: page, nextCursor: { createdAt: key.createdAt.toISOString(), id: key.id } };
}

export type { PageCursor };
