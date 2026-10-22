import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySnapshot, applyEvents } from '../../app/utils/run-reducer';
import type { ServerFrame, WireEvent } from '../../shared/run-wire';
import { RunHub, cohortFor } from '../../server/runs/run-hub';
import type { HubPeer, SubscriptionGrant } from '../../server/runs/run-hub';
import { TicketStore } from '../../server/runs/subscription-ticket';

/** A socket that records what it was sent. */
function fakePeer() {
  const frames: Record<string, unknown>[] = [];
  let closed = false;
  const peer: HubPeer = {
    send: (data: string) => { frames.push(JSON.parse(data)); },
    close: () => { closed = true; },
  };
  return {
    peer,
    frames,
    get closed() { return closed; },
    events(): WireEvent[] {
      return frames.filter((f) => f.k === 'events').flatMap((f) => f.events as WireEvent[]);
    },
  };
}

const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const RUN_A = '11111111-0000-0000-0000-000000000001';
const RUN_B = '22222222-0000-0000-0000-000000000002';

function grant(over: Partial<SubscriptionGrant> = {}): SubscriptionGrant {
  return { userId: 'u1', orgId: ORG_A, runId: RUN_A, cohort: 'full', ...over };
}

let seq = 0;
/**
 * WireEvent, the shape the snapshot sends — NOT a bare MigrationEvent.
 *
 * This file used to build bare events, and `run-reducer.test.ts` built
 * WireEvents. Each half passed against its own idea of the wire, and the
 * mismatch only showed up in a browser. Both now use one shape.
 */
function ev(type: string, payload: Record<string, unknown> = {}, runId = RUN_A): WireEvent {
  seq += 1;
  const at = new Date(seq * 1000).toISOString();
  return {
    seq,
    type,
    at,
    level: (payload.level as string | undefined) ?? null,
    payload: { type, runId, seq, at, ...payload },
  };
}

const log = (runId = RUN_A) => ev('log', { level: 'info', message: 'SELECT * FROM customers' }, runId);
const progress = (runId = RUN_A) =>
  ev('overall_progress', { rowsDone: 1, rowsTotal: 2, pct: 50, tablesDone: 0, tablesTotal: 1 }, runId);

describe('cross-org isolation', () => {
  it('never delivers one org\'s run to another org\'s subscriber', () => {
    // The single easiest leak in this design: two orgs, and a room name that
    // did not include the org.
    const hub = new RunHub();
    const a = fakePeer();
    const b = fakePeer();

    hub.subscribe(a.peer, grant({ orgId: ORG_A, runId: RUN_A }));
    hub.subscribe(b.peer, grant({ userId: 'u2', orgId: ORG_B, runId: RUN_B }));

    hub.publish(RUN_A, [progress(RUN_A)]);

    expect(a.events()).toHaveLength(1);
    expect(b.events()).toHaveLength(0);
  });

  it('keeps two orgs in separate rooms even for the same run id', () => {
    // A run id is a server-generated UUID and cannot collide across orgs — but
    // the room key includes the org anyway, so a future change that made ids
    // client-influenced could not turn into a cross-tenant broadcast.
    const hub = new RunHub();
    const a = fakePeer();
    const b = fakePeer();

    hub.subscribe(a.peer, grant({ orgId: ORG_A, runId: RUN_A }));
    hub.subscribe(b.peer, grant({ userId: 'u2', orgId: ORG_B, runId: RUN_A }));

    expect(hub.stats()).toEqual({ peers: 2, rooms: 2, runs: 1 });
  });

  it('exposes no way to join a room from a raw string', () => {
    // The structural guarantee: `subscribe` accepts only a SubscriptionGrant,
    // and the only producer of one is ticket redemption. If someone later adds
    // a string-keyed join, this file is where it should hurt.
    const source = readFileSync(join(__dirname, '../../server/runs/run-hub.ts'), 'utf8');

    // roomKey takes the grant itself, not loose parts that a caller could
    // assemble from request input.
    expect(source).toMatch(/function roomKey\(grant: SubscriptionGrant\): string/);
    expect(source).not.toMatch(/export function roomKey/);
    // And nothing in the hub reads a slug — slugs are client-supplied.
    expect(source).not.toMatch(/orgSlug/);
  });

  it('scopes the snapshot read by org, not only by run id', () => {
    // snapshot.ts is the one database read outside the org-scoped repository
    // wall — a WebSocket peer is not a request, so there is no H3Event and no
    // createRepos(). The scoping is therefore written out by hand, which means
    // it can be deleted by hand. This is the thing that would notice.
    const source = readFileSync(join(__dirname, '../../server/runs/snapshot.ts'), 'utf8');

    expect(source).toMatch(/eq\(runs\.orgId, grant\.orgId\)/);
    // And the cohort decides which event types are ASKED for, rather than
    // fetching everything and trusting a filter on the way out.
    expect(source).toMatch(/grant\.cohort === 'full' \? undefined :/);
  });

  it('never lets the socket handler make an authorisation decision of its own', () => {
    // It redeems a grant and nothing else. A requirePermission or a repository
    // here would be a second implementation of "what may this person see".
    const source = readFileSync(join(__dirname, '../../server/routes/_ws/runs.ts'), 'utf8');

    expect(source).not.toMatch(/requirePermission|requireOrgRole|createRepos/);
    expect(source).toMatch(/redeem\(/);
  });

  it('routes a ticket grant straight into the room, with no client value in between', () => {
    const tickets = new TicketStore();
    const hub = new RunHub();
    const a = fakePeer();

    const { ticket } = tickets.mint(grant());
    const redeemed = tickets.redeem(ticket);
    expect(redeemed).toEqual(grant());

    hub.subscribe(a.peer, redeemed!);
    hub.publish(RUN_A, [progress()]);
    expect(a.events()).toHaveLength(1);
  });
});

describe('log cohorts', () => {
  it('withholds log events from the redacted room and sends everything else', () => {
    const hub = new RunHub();
    const full = fakePeer();
    const redacted = fakePeer();

    hub.subscribe(full.peer, grant({ cohort: 'full' }));
    hub.subscribe(redacted.peer, grant({ userId: 'u2', cohort: 'redacted' }));

    hub.publish(RUN_A, [log(), progress()]);

    expect(full.events().map((e) => e.type)).toEqual(['log', 'overall_progress']);
    // Movy's logs quote SQL, table names and driver errors.
    expect(redacted.events().map((e) => e.type)).toEqual(['overall_progress']);
  });

  it('sends nothing at all to a redacted peer when the batch is only logs', () => {
    const hub = new RunHub();
    const redacted = fakePeer();
    hub.subscribe(redacted.peer, grant({ cohort: 'redacted' }));

    hub.publish(RUN_A, [log(), log()]);

    // Not an empty frame: an empty batch still tells a viewer that log traffic
    // is happening, and costs a wakeup for nothing.
    expect(redacted.frames).toHaveLength(0);
  });

  it('derives the cohort from the role, using the same predicate as the REST route', () => {
    expect(cohortFor('viewer')).toBe('redacted');
    expect(cohortFor('editor')).toBe('full');
    expect(cohortFor('admin')).toBe('full');
  });

  it('puts a new event type in front of both cohorts, not just one', () => {
    // The split is "everything except log", not an allowlist — so an event
    // type added to the core later reaches viewers instead of silently
    // vanishing from their timeline.
    const hub = new RunHub();
    const redacted = fakePeer();
    hub.subscribe(redacted.peer, grant({ cohort: 'redacted' }));

    hub.publish(RUN_A, [ev('some_future_event')]);

    expect(redacted.events()).toHaveLength(1);
  });
});

describe('subscription lifecycle', () => {
  it('stops delivering after a peer disconnects', () => {
    const hub = new RunHub();
    const a = fakePeer();
    hub.subscribe(a.peer, grant());
    hub.unsubscribe(a.peer);

    hub.publish(RUN_A, [progress()]);

    expect(a.events()).toHaveLength(0);
    expect(hub.stats()).toEqual({ peers: 0, rooms: 0, runs: 0 });
  });

  it('moves rather than duplicates when a peer re-subscribes', () => {
    const hub = new RunHub();
    const a = fakePeer();
    hub.subscribe(a.peer, grant({ cohort: 'full' }));
    hub.subscribe(a.peer, grant({ cohort: 'redacted' }));

    expect(hub.stats().peers).toBe(1);
    hub.publish(RUN_A, [log(), progress()]);
    expect(a.events().map((e) => e.type)).toEqual(['overall_progress']);
  });

  it('drops a peer whose socket throws instead of failing the broadcast', () => {
    const hub = new RunHub();
    const good = fakePeer();
    const broken: HubPeer = { send: () => { throw new Error('socket closed'); } };

    hub.subscribe(broken, grant({ userId: 'u2' }));
    hub.subscribe(good.peer, grant());

    hub.publish(RUN_A, [progress()]);

    // Telemetry must never take down the process supervising a migration.
    expect(good.events()).toHaveLength(1);
    expect(hub.stats().peers).toBe(1);
  });

  it('is a no-op when nobody is watching', () => {
    const hub = new RunHub();
    expect(() => hub.publish(RUN_A, [progress()])).not.toThrow();
  });

  it('ignores an empty batch', () => {
    const hub = new RunHub();
    const a = fakePeer();
    hub.subscribe(a.peer, grant());
    hub.publish(RUN_A, []);
    expect(a.frames).toHaveLength(0);
  });
});

describe('revalidation — a demotion must reach a live socket', () => {
  it('moves a demoted subscriber into the redacted room', async () => {
    const resolveRole = vi.fn(async (pairs: readonly { orgId: string; userId: string }[]) =>
      new Map(pairs.map((p) => [`${p.orgId}:${p.userId}`, 'viewer' as const]))
    );
    const hub = new RunHub({ resolveRole });
    const a = fakePeer();

    hub.subscribe(a.peer, grant({ cohort: 'full' }));
    const result = await hub.revalidate();

    expect(result).toEqual({ moved: 1, evicted: 0 });
    expect(a.frames.some((f) => f.k === 'cohort_changed' && f.cohort === 'redacted')).toBe(true);

    hub.publish(RUN_A, [log(), progress()]);
    expect(a.events().map((e) => e.type)).toEqual(['overall_progress']);
  });

  it('evicts and closes a subscriber who left the org', async () => {
    const hub = new RunHub({ resolveRole: async () => new Map() });
    const a = fakePeer();
    hub.subscribe(a.peer, grant());

    const result = await hub.revalidate();

    expect(result).toEqual({ moved: 0, evicted: 1 });
    expect(a.closed).toBe(true);
    expect(hub.stats().peers).toBe(0);

    hub.publish(RUN_A, [progress()]);
    expect(a.events()).toHaveLength(0);
  });

  it('leaves an unchanged subscriber alone', async () => {
    const hub = new RunHub({
      resolveRole: async (pairs) => new Map(pairs.map((p) => [`${p.orgId}:${p.userId}`, 'editor' as const])),
    });
    const a = fakePeer();
    hub.subscribe(a.peer, grant({ cohort: 'full' }));

    expect(await hub.revalidate()).toEqual({ moved: 0, evicted: 0 });
    expect(a.frames).toHaveLength(0);
  });

  it('asks one question per person, however many runs they watch', async () => {
    // The check runs every few seconds; per-peer queries would make that cost
    // scale with the audience, and the interval is the exposure window for a
    // demoted viewer, so it must stay short.
    const seen: unknown[] = [];
    const hub = new RunHub({
      resolveRole: async (pairs) => {
        seen.push(pairs);
        return new Map(pairs.map((p) => [`${p.orgId}:${p.userId}`, 'editor' as const]));
      },
    });

    const one = fakePeer();
    const two = fakePeer();
    const other = fakePeer();
    hub.subscribe(one.peer, grant({ userId: 'u1', runId: RUN_A }));
    hub.subscribe(two.peer, grant({ userId: 'u1', runId: RUN_B }));
    hub.subscribe(other.peer, grant({ userId: 'u2', runId: RUN_A }));

    await hub.revalidate();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(2); // u1 and u2, not three subscriptions
  });

  it('asks nothing at all when nobody is watching', async () => {
    const resolveRole = vi.fn();
    const hub = new RunHub({ resolveRole });
    expect(await hub.revalidate()).toEqual({ moved: 0, evicted: 0 });
    expect(resolveRole).not.toHaveBeenCalled();
  });

  it('keeps a subscriber when the role check itself fails', async () => {
    // A database blip must not disconnect everyone watching a migration.
    const onError = vi.fn();
    const hub = new RunHub({ resolveRole: async () => { throw new Error('db down'); }, onError });
    const a = fakePeer();
    hub.subscribe(a.peer, grant());

    expect(await hub.revalidate()).toEqual({ moved: 0, evicted: 0 });
    expect(hub.stats().peers).toBe(1);
    expect(onError).toHaveBeenCalledOnce();
  });
});


describe('the live frame and the snapshot speak the same shape', () => {
  /**
   * REGRESSION. The hub used to publish bare MigrationEvents while the
   * snapshot sent WireEvent rows, so every live frame threw in the reducer —
   * `payload` was undefined. Nothing caught it because this file tested the
   * hub with one shape and `run-reducer.test.ts` tested the reducer with the
   * other. This test makes the hub's real output feed the real reducer.
   */
  it('feeds a published frame straight through the reducer', () => {
    const hub = new RunHub();
    const peer = fakePeer();
    hub.subscribe(peer.peer, grant({ cohort: 'full' }));

    hub.publish(RUN_A, [
      ev('step_started', { stepId: 'sync_schema', ordinal: 3 }),
      ev('log', { level: 'info', message: 'Applying schema changes...' }),
      ev('table_finished', { tableName: 'orders', rowsCopied: 60_000, durationMs: 900, success: true }),
    ]);

    const run = {
      id: RUN_A, status: 'running', mode: 'full', simulated: true,
      source: { engine: 'postgres', database: 'src' },
      target: { engine: 'postgres', database: 'dst' },
      progress: { rowsDone: 0, rowsTotal: 0, tablesDone: 0, tablesTotal: 0, pct: 0 },
      lastSeq: 0, error: null, createdAt: new Date().toISOString(),
      startedAt: null, finishedAt: null, durationMs: null,
    };
    const snapshot: Extract<ServerFrame, { k: 'snapshot' }> = {
      k: 'snapshot', run, steps: [], tables: [], events: [], lastSeq: 0, cohort: 'full',
    };

    const state = applyEvents(applySnapshot(snapshot), peer.events());

    expect(state.steps.find((s) => s.stepId === 'sync_schema')?.status).toBe('running');
    expect(state.logs.map((l) => l.message)).toEqual(['Applying schema changes...']);
    expect(state.tables[0]).toMatchObject({ tableName: 'orders', status: 'done', rowsDone: 60_000 });
  });

  it('gives a redacted subscriber frames the reducer can still fold', () => {
    const hub = new RunHub();
    const peer = fakePeer();
    hub.subscribe(peer.peer, grant({ cohort: 'redacted' }));

    hub.publish(RUN_A, [
      ev('log', { level: 'info', message: 'SELECT * FROM customers' }),
      ev('overall_progress', { rowsDone: 5, rowsTotal: 10, pct: 50, tablesDone: 1, tablesTotal: 2 }),
    ]);

    const run = {
      id: RUN_A, status: 'running', mode: 'full', simulated: true,
      source: { engine: 'postgres', database: 'src' },
      target: { engine: 'postgres', database: 'dst' },
      progress: { rowsDone: 0, rowsTotal: 0, tablesDone: 0, tablesTotal: 0, pct: 0 },
      lastSeq: 0, error: null, createdAt: new Date().toISOString(),
      startedAt: null, finishedAt: null, durationMs: null,
    };
    const state = applyEvents(
      applySnapshot({ k: 'snapshot', run, steps: [], tables: [], events: [], lastSeq: 0, cohort: 'redacted' }),
      peer.events()
    );

    expect(state.logs).toHaveLength(0);
    expect(state.run?.progress.pct).toBe(50);
  });
});
