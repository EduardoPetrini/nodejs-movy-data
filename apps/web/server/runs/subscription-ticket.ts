import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { SubscriptionGrant } from './run-hub';

/**
 * A one-shot, short-lived right to open a run stream.
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
 * Single-process, in memory, like the RunManager it serves. Behind more than
 * one Nitro instance this becomes a shared store or a signed token — but the
 * ticket would still be minted and redeemed the same way.
 */
export interface TicketStoreOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

interface Issued {
  readonly grant: SubscriptionGrant;
  readonly expiresAt: number;
}

/** Long enough to open a socket, far too short to be worth stealing. */
const DEFAULT_TTL_MS = 30_000;

export class TicketStore {
  private readonly issued = new Map<string, Issued>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: TicketStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  mint(grant: SubscriptionGrant): { ticket: string; expiresInMs: number } {
    this.sweep();
    // 32 bytes of CSPRNG. The ticket is a bearer credential for one run's
    // event stream, so it is generated the way a session id would be.
    const ticket = randomBytes(32).toString('base64url');
    this.issued.set(ticket, { grant, expiresAt: this.now() + this.ttlMs });
    return { ticket, expiresInMs: this.ttlMs };
  }

  /**
   * Redeems once and only once.
   *
   * Deleting on redemption means a ticket that leaks — a log line, a proxy
   * access log, a screenshot — is already spent by the time anyone finds it.
   */
  redeem(ticket: unknown): SubscriptionGrant | null {
    if (typeof ticket !== 'string' || ticket.length === 0) return null;
    this.sweep();

    const found = this.find(ticket);
    if (!found) return null;

    this.issued.delete(found.key);
    if (found.entry.expiresAt <= this.now()) return null;
    return found.entry.grant;
  }

  size(): number {
    this.sweep();
    return this.issued.size;
  }

  /**
   * Constant-time lookup over the issued set.
   *
   * A plain Map.get() on attacker-supplied input leaks match length through
   * timing. The set is tiny and short-lived, so scanning it costs nothing.
   */
  private find(ticket: string): { key: string; entry: Issued } | null {
    const candidate = Buffer.from(ticket);
    let match: { key: string; entry: Issued } | null = null;

    for (const [key, entry] of this.issued) {
      const known = Buffer.from(key);
      if (known.length !== candidate.length) continue;
      if (timingSafeEqual(known, candidate)) match = { key, entry };
    }
    return match;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.issued) {
      if (entry.expiresAt <= now) this.issued.delete(key);
    }
  }
}
