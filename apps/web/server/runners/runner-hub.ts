import type { OrgRole } from '../db/schema';
import type { RunnersSnapshot } from '../../shared/runner-wire';
import { memberKey, type HubPeer, type RoleResolver } from '../runs/run-hub';

/** Admins see runner ids; everyone else sees counts. */
export type RunnersAudience = 'admin' | 'member';

export function audienceFor(role: OrgRole): RunnersAudience {
  return role === 'admin' ? 'admin' : 'member';
}

/**
 * A verified right to watch an org's runner availability. Minted only by
 * `POST /api/orgs/:slug/runners/ticket`, from the membership read on that
 * request — never from anything the socket carries.
 */
export interface RunnersGrant {
  readonly userId: string;
  readonly orgId: string;
  readonly audience: RunnersAudience;
}

/** Reachable only with a grant, so nothing typed on the socket can name a room. */
function roomKey(grant: RunnersGrant): string {
  return `org:${grant.orgId}:runners:${grant.audience}`;
}

interface Room {
  readonly orgId: string;
  readonly audience: RunnersAudience;
  readonly members: Set<Membership>;
  /** The last frame sent, without its timestamp: only a change is re-sent. */
  last: string | null;
}

interface Membership {
  readonly peer: HubPeer;
  readonly grant: RunnersGrant;
  readonly room: string;
}

export interface RunnerHubOptions {
  /** The snapshot for one org; `includeRunners` only for the admin room. */
  readonly load: (orgId: string, includeRunners: boolean) => Promise<RunnersSnapshot>;
  readonly resolveRole?: RoleResolver;
  /** How often to refresh while anyone watches: busy counts change without a NOTIFY. */
  readonly refreshIntervalMs?: number;
  readonly onError?: (err: Error) => void;
}

/**
 * Pushes runner availability to the org home and runs page.
 *
 * Refreshed on `NOTIFY movy_runners` (a runner came, went or started draining)
 * and on an interval while anyone watches, because free slots change with
 * every claim and a heartbeat does not announce itself. One query per room,
 * not per subscriber, and only a changed frame is sent.
 *
 * Roles are re-checked on every refresh with the run hub's resolver, so a
 * demoted admin stops seeing runner ids within one interval.
 */
export class RunnerHub {
  private readonly rooms = new Map<string, Room>();
  private readonly byPeer = new Map<HubPeer, Membership>();
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private readonly onError: NonNullable<RunnerHubOptions['onError']>;

  constructor(private readonly options: RunnerHubOptions) {
    this.onError = options.onError ?? (() => {});
  }

  /** Joins the grant's room and sends that room's current snapshot. */
  async subscribe(peer: HubPeer, grant: RunnersGrant): Promise<void> {
    this.unsubscribe(peer);
    const key = roomKey(grant);
    const room = this.rooms.get(key) ?? { orgId: grant.orgId, audience: grant.audience, members: new Set(), last: null };
    const membership: Membership = { peer, grant, room: key };
    room.members.add(membership);
    this.rooms.set(key, room);
    this.byPeer.set(peer, membership);
    this.arm();

    const snapshot = await this.options.load(grant.orgId, grant.audience === 'admin');
    const frame = JSON.stringify({ k: 'runners', ...snapshot });
    const signature = signatureOf(snapshot);
    if (signature === room.last) {
      this.deliver(membership, frame);
      return;
    }
    // Newer than what the room last saw: everyone in it gets it, not only the
    // newcomer, or the others would sit on the stale view until the next change.
    room.last = signature;
    for (const member of [...room.members]) this.deliver(member, frame);
  }

  unsubscribe(peer: HubPeer): void {
    const membership = this.byPeer.get(peer);
    if (!membership) return;
    this.byPeer.delete(peer);
    const room = this.rooms.get(membership.room);
    room?.members.delete(membership);
    if (room && room.members.size === 0) this.rooms.delete(membership.room);
    if (this.byPeer.size === 0) this.disarm();
  }

  /** Revalidate roles, then send every room whose snapshot changed. Calls coalesce. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = this.refreshOnce().finally(() => {
      this.refreshing = null;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    });
    return this.refreshing;
  }

  stats(): { peers: number; rooms: number } {
    return { peers: this.byPeer.size, rooms: this.rooms.size };
  }

  close(): void {
    this.disarm();
    for (const peer of [...this.byPeer.keys()]) this.unsubscribe(peer);
  }

  private async refreshOnce(): Promise<void> {
    if (this.byPeer.size === 0) return;
    await this.revalidate();

    for (const room of this.rooms.values()) {
      if (room.members.size === 0) continue;
      let snapshot: RunnersSnapshot;
      try {
        snapshot = await this.options.load(room.orgId, room.audience === 'admin');
      } catch (err) {
        this.onError(toError(err));
        continue;
      }
      const signature = signatureOf(snapshot);
      if (signature === room.last) continue;
      room.last = signature;
      const frame = JSON.stringify({ k: 'runners', ...snapshot });
      for (const member of [...room.members]) this.deliver(member, frame);
    }
  }

  private async revalidate(): Promise<void> {
    if (!this.options.resolveRole) return;
    const memberships = [...this.byPeer.values()];
    const pairs = new Map<string, { orgId: string; userId: string }>();
    for (const { grant } of memberships) pairs.set(memberKey(grant.orgId, grant.userId), { orgId: grant.orgId, userId: grant.userId });

    let roles: ReadonlyMap<string, OrgRole>;
    try {
      roles = await this.options.resolveRole([...pairs.values()]);
    } catch (err) {
      // A failed check must not evict legitimate subscribers.
      this.onError(toError(err));
      return;
    }

    for (const membership of memberships) {
      const role = roles.get(memberKey(membership.grant.orgId, membership.grant.userId));
      if (!role) {
        this.deliver(membership, JSON.stringify({ k: 'revoked', reason: 'no-longer-a-member' }));
        this.unsubscribe(membership.peer);
        membership.peer.close?.();
        continue;
      }
      const audience = audienceFor(role);
      if (audience !== membership.grant.audience) {
        // Moved, and sent the new room's view straight away by the loop that follows.
        this.unsubscribe(membership.peer);
        const grant = { ...membership.grant, audience };
        const key = roomKey(grant);
        const room = this.rooms.get(key) ?? { orgId: grant.orgId, audience, members: new Set(), last: null };
        room.last = null;
        room.members.add({ peer: membership.peer, grant, room: key });
        this.rooms.set(key, room);
        this.byPeer.set(membership.peer, { peer: membership.peer, grant, room: key });
        this.arm();
      }
    }
  }

  private deliver(membership: Membership, frame: string): void {
    try {
      membership.peer.send(frame);
    } catch (err) {
      this.onError(toError(err));
      this.unsubscribe(membership.peer);
    }
  }

  private arm(): void {
    const ms = this.options.refreshIntervalMs ?? 5_000;
    if (this.timer !== null || ms <= 0) return;
    this.timer = setInterval(() => void this.refresh(), ms);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/** A snapshot without its timestamp, which changes every time and means nothing. */
function signatureOf(snapshot: RunnersSnapshot): string {
  const { at: _at, ...stable } = snapshot;
  return JSON.stringify(stable);
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
