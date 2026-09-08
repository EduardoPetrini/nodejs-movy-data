import type { OrgRole } from '../db/schema';
import type { WireEvent } from '../../shared/run-wire';
import { mayReadLogs } from '../serializers/run.serializer';

/**
 * The two log cohorts, as rooms.
 *
 * `full` gets everything. `redacted` gets the timeline without `log` events —
 * Movy's logs quote SQL, table names and driver errors, which a read-only
 * viewer is not meant to have. The split is a room rather than a per-message
 * filter so that a new event type can never default into the wrong audience:
 * it goes to both rooms unless it is a log.
 */
export type Cohort = 'full' | 'redacted';

export function cohortFor(role: OrgRole): Cohort {
  return mayReadLogs(role) ? 'full' : 'redacted';
}

/** The subset of a socket the hub needs. Narrow, so it fakes in a test. */
export interface HubPeer {
  send(data: string): void;
  close?(): void;
}

/**
 * A verified right to watch one run.
 *
 * Every field is server-minted: `orgId` and `cohort` come from a membership row
 * read on the HTTP request that issued the ticket, and `runId` from an
 * org-scoped lookup that returns nothing for another org's run. Nothing the
 * client typed reaches this object, which is the whole point — see roomKey().
 */
export interface SubscriptionGrant {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly cohort: Cohort;
}

/**
 * The single most dangerous line in this design, so it is the smallest.
 *
 * A room name assembled from client input — an org slug off the wire, a run id
 * the client asked for — is the easiest cross-org leak available here: one
 * peer joins `org:acme:...` by saying so, and every subsequent broadcast is a
 * disclosure. This function is therefore reachable ONLY with a
 * SubscriptionGrant, which only the ticket redemption path can produce.
 * `socket-isolation.test.ts` fails if a raw string can reach a room.
 */
function roomKey(grant: SubscriptionGrant): string {
  return `org:${grant.orgId}:run:${grant.runId}:${grant.cohort}`;
}

interface Membership {
  readonly peer: HubPeer;
  readonly grant: SubscriptionGrant;
  readonly room: string;
}

/**
 * Resolves the CURRENT role of every subscriber, in one call.
 *
 * Batched rather than per-peer on purpose. A socket outlives the request that
 * authorised it, so a demotion only takes effect when this runs — and the rule
 * in this codebase is that a demotion takes effect on the next request, not at
 * the next login. Making the check one query regardless of how many people are
 * watching is what lets it run often enough for that to nearly hold.
 *
 * A pair absent from the returned map is no longer a member.
 */
export type RoleResolver = (
  pairs: readonly { readonly orgId: string; readonly userId: string }[]
) => Promise<ReadonlyMap<string, OrgRole>>;

/** The key shape the resolver returns. One place, so both sides agree. */
export function memberKey(orgId: string, userId: string): string {
  return `${orgId}:${userId}`;
}

export interface RunHubOptions {
  readonly resolveRole?: RoleResolver;
  /**
   * How often to re-check every subscriber's role — and therefore the upper
   * bound on how long a demoted viewer keeps seeing log lines. Short because
   * the check is a single batched query, not one per subscriber.
   */
  readonly revalidateIntervalMs?: number;
  readonly onError?: (err: Error) => void;
}

/**
 * Fans run events out to subscribed sockets, grouped by org, run and cohort.
 *
 * Membership lives here rather than in the transport's own pub/sub so that it
 * is a data structure this project can test directly. Isolation asserted by a
 * unit test beats isolation asserted by a library's documentation.
 */
export class RunHub {
  /** runId -> room key -> members. Indexed by run because that is how events arrive. */
  private readonly byRun = new Map<string, Map<string, Set<Membership>>>();
  private readonly byPeer = new Map<HubPeer, Membership>();
  private revalidateTimer: NodeJS.Timeout | null = null;

  private readonly resolveRole: RoleResolver | null;
  private readonly revalidateIntervalMs: number;
  private readonly onError: (err: Error) => void;

  constructor(options: RunHubOptions = {}) {
    this.resolveRole = options.resolveRole ?? null;
    this.revalidateIntervalMs = options.revalidateIntervalMs ?? 5_000;
    this.onError = options.onError ?? (() => {});
  }

  /** One peer watches one run. Re-subscribing moves it rather than duplicating it. */
  subscribe(peer: HubPeer, grant: SubscriptionGrant): void {
    this.unsubscribe(peer);

    const room = roomKey(grant);
    const rooms = this.byRun.get(grant.runId) ?? new Map<string, Set<Membership>>();
    const members = rooms.get(room) ?? new Set<Membership>();

    const membership: Membership = { peer, grant, room };
    members.add(membership);
    rooms.set(room, members);
    this.byRun.set(grant.runId, rooms);
    this.byPeer.set(peer, membership);

    this.arm();
  }

  unsubscribe(peer: HubPeer): void {
    const membership = this.byPeer.get(peer);
    if (!membership) return;
    this.byPeer.delete(peer);

    const rooms = this.byRun.get(membership.grant.runId);
    const members = rooms?.get(membership.room);
    members?.delete(membership);

    if (members && members.size === 0) rooms!.delete(membership.room);
    if (rooms && rooms.size === 0) this.byRun.delete(membership.grant.runId);

    if (this.byPeer.size === 0) this.disarm();
  }

  /**
   * Deliver a batch to everyone watching this run.
   *
   * Called only AFTER the batch is durably stored. That ordering is what stops
   * a client which loaded its snapshot from the database and then went live
   * from having a hole: every event it could miss is already queryable by the
   * time anyone is told about it.
   */
  publish(runId: string, events: readonly WireEvent[]): void {
    if (events.length === 0) return;
    const rooms = this.byRun.get(runId);
    if (!rooms) return;

    for (const [room, members] of rooms) {
      if (members.size === 0) continue;
      const payload = room.endsWith(':redacted') ? events.filter((e) => e.type !== 'log') : events;
      if (payload.length === 0) continue;

      const frame = JSON.stringify({ k: 'events', runId, events: payload });
      for (const member of members) this.deliver(member, frame);
    }
  }

  /** Send one message to one peer, e.g. its opening snapshot. */
  sendTo(peer: HubPeer, message: unknown): void {
    const membership = this.byPeer.get(peer);
    if (!membership) return;
    this.deliver(membership, JSON.stringify(message));
  }

  /**
   * Re-check every subscriber's role against the database.
   *
   * A demotion moves the peer into the redacted room; losing membership
   * altogether closes the socket. Both take effect within one interval rather
   * than at the subscriber's next reconnect.
   */
  async revalidate(): Promise<{ moved: number; evicted: number }> {
    if (!this.resolveRole || this.byPeer.size === 0) return { moved: 0, evicted: 0 };

    const memberships = [...this.byPeer.values()];
    // Deduplicated: one person watching three runs is one membership question.
    const pairs = new Map<string, { orgId: string; userId: string }>();
    for (const { grant } of memberships) {
      pairs.set(memberKey(grant.orgId, grant.userId), { orgId: grant.orgId, userId: grant.userId });
    }

    let roles: ReadonlyMap<string, OrgRole>;
    try {
      roles = await this.resolveRole([...pairs.values()]);
    } catch (err) {
      // A failed check must not evict legitimate subscribers; leave everyone
      // where they are and try again next interval.
      this.onError(err instanceof Error ? err : new Error(String(err)));
      return { moved: 0, evicted: 0 };
    }

    let moved = 0;
    let evicted = 0;

    for (const membership of memberships) {
      const { orgId, userId, cohort } = membership.grant;
      const role = roles.get(memberKey(orgId, userId)) ?? null;

      if (role === null) {
        this.deliver(membership, JSON.stringify({ k: 'revoked', reason: 'no-longer-a-member' }));
        this.unsubscribe(membership.peer);
        membership.peer.close?.();
        evicted += 1;
        continue;
      }

      const current = cohortFor(role);
      if (current !== cohort) {
        this.subscribe(membership.peer, { ...membership.grant, cohort: current });
        this.deliver(membership, JSON.stringify({ k: 'cohort_changed', cohort: current }));
        moved += 1;
      }
    }

    return { moved, evicted };
  }

  stats(): { peers: number; rooms: number; runs: number } {
    let rooms = 0;
    for (const map of this.byRun.values()) rooms += map.size;
    return { peers: this.byPeer.size, rooms, runs: this.byRun.size };
  }

  close(): void {
    this.disarm();
    for (const peer of [...this.byPeer.keys()]) this.unsubscribe(peer);
  }

  private deliver(membership: Membership, frame: string): void {
    try {
      membership.peer.send(frame);
    } catch (err) {
      // A dead socket is not an error worth propagating into a live migration;
      // drop the subscriber and carry on.
      this.onError(err instanceof Error ? err : new Error(String(err)));
      this.unsubscribe(membership.peer);
    }
  }

  private arm(): void {
    if (this.revalidateTimer !== null || !this.resolveRole) return;
    this.revalidateTimer = setInterval(() => {
      void this.revalidate().catch((err: unknown) => {
        this.onError(err instanceof Error ? err : new Error(String(err)));
      });
    }, this.revalidateIntervalMs);
    this.revalidateTimer.unref?.();
  }

  private disarm(): void {
    if (this.revalidateTimer === null) return;
    clearInterval(this.revalidateTimer);
    this.revalidateTimer = null;
  }
}
