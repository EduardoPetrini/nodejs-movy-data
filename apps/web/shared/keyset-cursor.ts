/**
 * The ledger's page cursor: `(createdAt, id)`, encoded.
 *
 * Keyset rather than `OFFSET` because the list being paged has rows inserted
 * at its head while it is being read — that is what a run ledger IS. Under
 * `OFFSET 50`, a run started between page one and page two shifts every
 * subsequent row down by one, so the reader sees a run twice and never sees
 * another. A cursor naming the last row read cannot do that, whatever arrives
 * above it.
 *
 * `id` is in the cursor as well as `createdAt` because two runs created in the
 * same millisecond are not hypothetical: launching a definition twice is one
 * click apart, and `createdAt` alone would either repeat one or skip one at
 * exactly the page boundary.
 *
 * In `shared/` because the client passes the cursor back verbatim, so both
 * halves need the same idea of what one is — though only the server ever
 * builds or reads the inside of one.
 */

export interface PageCursor {
  /** ISO 8601, as `Date.toISOString()` writes it. */
  createdAt: string;
  id: string;
}

/** Opaque on purpose: a cursor is a position, not an API to construct by hand. */
export function encodeCursor(cursor: PageCursor): string {
  return base64UrlEncode(`${cursor.createdAt}|${cursor.id}`);
}

/**
 * `undefined` for anything that is not a cursor this module wrote.
 *
 * Never throws and never guesses. The caller turns `undefined` into a 400
 * rather than silently serving page one, because a paging client that gets
 * the first page back when it asked for the third loops forever.
 */
export function decodeCursor(raw: unknown): PageCursor | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return undefined;

  let decoded: string;
  try {
    decoded = base64UrlDecode(raw);
  } catch {
    return undefined;
  }

  const separator = decoded.indexOf('|');
  if (separator < 0) return undefined;

  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);

  // A timestamp that does not parse would become `NULL` in the comparison and
  // silently match every row.
  if (Number.isNaN(Date.parse(createdAt))) return undefined;
  if (!UUID.test(id)) return undefined;

  return { createdAt, id };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Base64url, hand-rolled over the platform primitives.
 *
 * `Buffer` exists only on the server and `btoa` only handles Latin-1, so
 * neither is usable on its own in a `shared/` module. Both halves of a cursor
 * are ASCII by construction — an ISO timestamp and a UUID.
 */
function base64UrlEncode(text: string): string {
  const base64 =
    typeof Buffer !== 'undefined'
      ? Buffer.from(text, 'utf8').toString('base64')
      : btoa(text);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('not base64url');
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return typeof Buffer !== 'undefined'
    ? Buffer.from(base64, 'base64').toString('utf8')
    : atob(base64);
}
