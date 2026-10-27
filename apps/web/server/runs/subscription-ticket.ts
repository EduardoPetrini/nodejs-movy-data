import { createHash, randomBytes } from 'node:crypto';
import type { SqlClient } from '@movy/runner/agent';
import type { StreamTicketKind } from '../db/schema';

/**
 * A one-shot, short-lived right to open a live stream.
 *
 * WHY NOT THE SESSION COOKIE. The cookie is readable at the WebSocket upgrade,
 * but `getUserSession()` needs a real H3Event and there is none there — so
 * cookie auth would mean reimplementing nuxt-auth-utils' unsealing inside the
 * socket layer, and then re-resolving org and role a second way. Two
 * implementations of "who is this and what may they see" is how the second one
 * ends up wrong.
 *
 * A ticket is minted by an ordinary HTTP request, which has already been
 * through `01.auth`, `02.org` (membership and role, read fresh), a
 * `requirePermission` gate and an org-scoped repository lookup. The socket then
 * performs no authorisation of its own: it redeems a grant that is already
 * decided. That is what makes it impossible for anything the client typed to
 * reach a room key.
 *
 * IN THE META-DATABASE, NOT IN MEMORY. Behind a load balancer the request that
 * mints a ticket and the socket that redeems it can land on different web
 * replicas, so the ticket lives in `stream_tickets` and any replica redeems it.
 *
 * - Only sha256(ticket) is stored. A dump or backup holds nothing a browser
 *   could present.
 * - Redemption is ONE `DELETE … RETURNING`: of two replicas redeeming the same
 *   ticket, row locking lets exactly one statement return the row.
 * - Expiry is the database's `now()`, so clock skew between replicas neither
 *   stretches nor shortens a ticket.
 * - The lookup is no longer a constant-time scan, on purpose: the key is a
 *   digest of the client's input, so timing says nothing about a stored ticket.
 */
export interface TicketStoreOptions<G> {
  readonly sql: SqlClient;
  /** Keeps the two streams apart: a run ticket never opens the runners socket. */
  readonly kind: StreamTicketKind;
  /** Rebuilds a stored grant field by field; null for any other shape. Never a cast. */
  readonly parse: (raw: unknown) => G | null;
  readonly ttlMs?: number;
}

/** Long enough to open a socket, far too short to be worth stealing. */
const DEFAULT_TTL_MS = 30_000;

export class TicketStore<G> {
  private readonly sql: SqlClient;
  private readonly kind: StreamTicketKind;
  private readonly parse: (raw: unknown) => G | null;
  private readonly ttlMs: number;

  constructor(options: TicketStoreOptions<G>) {
    this.sql = options.sql;
    this.kind = options.kind;
    this.parse = options.parse;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async mint(grant: G): Promise<{ ticket: string; expiresInMs: number }> {
    // Sweep on mint, as the in-memory store did; the expiry index keeps it cheap.
    await this.sql.query(`DELETE FROM stream_tickets WHERE expires_at < now()`);
    // 32 bytes of CSPRNG. The ticket is a bearer credential for one stream, so
    // it is generated the way a session id would be.
    const ticket = randomBytes(32).toString('base64url');
    await this.sql.query(
      `INSERT INTO stream_tickets (token_hash, kind, "grant", expires_at)
       VALUES ($1, $2, $3::jsonb, now() + make_interval(secs => $4::double precision / 1000))`,
      [digest(ticket), this.kind, JSON.stringify(grant), this.ttlMs]
    );
    return { ticket, expiresInMs: this.ttlMs };
  }

  /**
   * Redeems once and only once, on whichever replica asks first.
   *
   * Deleting on redemption means a ticket that leaks — a log line, a proxy
   * access log, a screenshot — is already spent by the time anyone finds it.
   * The `kind` filter leaves a ticket of the other kind untouched: presenting
   * it at the wrong socket must not spend it.
   */
  async redeem(ticket: unknown): Promise<G | null> {
    if (typeof ticket !== 'string' || ticket.length === 0) return null;

    const { rows } = await this.sql.query<{ grant: unknown; live: boolean }>(
      `DELETE FROM stream_tickets
        WHERE token_hash = $1 AND kind = $2
       RETURNING "grant", expires_at > now() AS live`,
      [digest(ticket), this.kind]
    );
    const row = rows[0];
    if (!row || !row.live) return null;
    return this.parse(row.grant);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** For the grant parsers: every id a grant carries is a uuid the server minted. */
export function isUuidShaped(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isGrantRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function digest(ticket: string): Buffer {
  return createHash('sha256').update(ticket).digest();
}
