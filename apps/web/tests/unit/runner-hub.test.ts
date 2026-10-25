import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunnerHub, audienceFor, type RunnersGrant } from '../../server/runners/runner-hub';
import { memberKey } from '../../server/runs/run-hub';
import type { RunnersSnapshot } from '../../shared/runner-wire';
import type { OrgRole } from '@movy/db';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

function fakePeer() {
  const frames: Record<string, unknown>[] = [];
  const peer = { send: (d: string) => frames.push(JSON.parse(d)), close: vi.fn() };
  return { peer, frames };
}

function grant(over: Partial<RunnersGrant> = {}): RunnersGrant {
  return { userId: 'u1', orgId: ORG_A, audience: 'member', ...over };
}

/** A loader whose answer the test changes, and which records who asked. */
function loader() {
  let free = 1;
  const calls: { orgId: string; includeRunners: boolean }[] = [];
  const load = vi.fn(async (orgId: string, includeRunners: boolean): Promise<RunnersSnapshot> => {
    calls.push({ orgId, includeRunners });
    return {
      at: new Date().toISOString(),
      classes: [{ name: 'default', label: 'Default', description: null, isDefault: true, online: 1, draining: 0, totalSlots: 2, freeSlots: free, queued: orgId === ORG_A ? 1 : 7 }],
      ...(includeRunners ? { runners: [{ id: 'host-1', runnerClass: 'default', state: 'online' as const, version: 'v', slots: 2, busy: 2 - free, lastHeartbeatAt: '' }] } : {}),
    };
  });
  return { load, calls, setFree: (n: number) => { free = n; } };
}

describe('RunnerHub', () => {
  it('sends a member its org\'s counts and no runner ids', async () => {
    const l = loader();
    const hub = new RunnerHub({ load: l.load });
    const p = fakePeer();
    await hub.subscribe(p.peer, grant());

    expect(p.frames).toHaveLength(1);
    expect(p.frames[0]).toMatchObject({ k: 'runners', classes: [{ queued: 1 }] });
    expect(p.frames[0]).not.toHaveProperty('runners');
    expect(l.calls).toEqual([{ orgId: ORG_A, includeRunners: false }]);
  });

  it('sends a platform operator the runners themselves', async () => {
    const l = loader();
    const hub = new RunnerHub({ load: l.load });
    const p = fakePeer();
    await hub.subscribe(p.peer, grant({ audience: 'operator' }));
    expect(p.frames[0]).toHaveProperty('runners');
  });

  it('keeps each org to its own room: another org\'s queue never reaches it', async () => {
    const l = loader();
    const hub = new RunnerHub({ load: l.load });
    const a = fakePeer();
    const b = fakePeer();
    await hub.subscribe(a.peer, grant({ orgId: ORG_A }));
    await hub.subscribe(b.peer, grant({ orgId: ORG_B, userId: 'u2' }));
    l.setFree(0);
    await hub.refresh();

    expect(a.frames.every((f) => (f.classes as { queued: number }[])[0].queued === 1)).toBe(true);
    expect(b.frames.every((f) => (f.classes as { queued: number }[])[0].queued === 7)).toBe(true);
  });

  it('re-sends only when something changed', async () => {
    const l = loader();
    const hub = new RunnerHub({ load: l.load });
    const p = fakePeer();
    await hub.subscribe(p.peer, grant());
    await hub.refresh();
    expect(p.frames).toHaveLength(1);

    l.setFree(0);
    await hub.refresh();
    expect(p.frames).toHaveLength(2);
    expect((p.frames[1].classes as { freeSlots: number }[])[0].freeSlots).toBe(0);
  });

  it('loads once per room, however many people are watching it', async () => {
    const l = loader();
    const hub = new RunnerHub({ load: l.load });
    await hub.subscribe(fakePeer().peer, grant({ userId: 'u1' }));
    await hub.subscribe(fakePeer().peer, grant({ userId: 'u2' }));
    l.calls.length = 0;
    await hub.refresh();
    expect(l.calls).toEqual([{ orgId: ORG_A, includeRunners: false }]);
  });

  it('moves a revoked operator to the member room, so runner ids stop', async () => {
    const l = loader();
    const roles = new Map<string, OrgRole>([[memberKey(ORG_A, 'u1'), 'admin']]);
    const hub = new RunnerHub({ load: l.load, resolveRole: async () => roles, resolveOperators: async () => new Set() });
    const p = fakePeer();
    await hub.subscribe(p.peer, grant({ audience: 'operator' }));
    await hub.refresh();

    const last = p.frames.at(-1)!;
    expect(last).toMatchObject({ k: 'runners' });
    expect(last).not.toHaveProperty('runners');
  });

  it('moves a newly granted operator to the operator room', async () => {
    const l = loader();
    const hub = new RunnerHub({ load: l.load, resolveOperators: async () => new Set(['u1']) });
    const p = fakePeer();
    await hub.subscribe(p.peer, grant());
    await hub.refresh();
    expect(p.frames.at(-1)).toHaveProperty('runners');
  });

  it('stops runner ids for an operator promoted and then revoked while connected', async () => {
    const l = loader();
    let operators = new Set(['u1']);
    const hub = new RunnerHub({ load: l.load, resolveOperators: async () => operators });
    const p = fakePeer();
    await hub.subscribe(p.peer, grant());
    await hub.refresh(); // promoted: into the operator room
    operators = new Set();
    await hub.refresh(); // revoked: out of it again
    expect(hub.stats().rooms).toBe(1);

    l.setFree(0);
    const before = p.frames.length;
    await hub.refresh();
    const sent = p.frames.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('runners');
  });

  it('leaves no room behind when a moved member disconnects', async () => {
    const l = loader();
    const hub = new RunnerHub({ load: l.load, resolveOperators: async () => new Set(['u1']) });
    const p = fakePeer();
    await hub.subscribe(p.peer, grant());
    await hub.refresh();
    hub.unsubscribe(p.peer);
    expect(hub.stats()).toEqual({ peers: 0, rooms: 0 });
  });

  it('keeps an org admin who is no operator in the member room: orgs are self-serve', async () => {
    const l = loader();
    const roles = new Map<string, OrgRole>([[memberKey(ORG_A, 'u1'), 'admin']]);
    const hub = new RunnerHub({ load: l.load, resolveRole: async () => roles, resolveOperators: async () => new Set() });
    const p = fakePeer();
    await hub.subscribe(p.peer, grant());
    await hub.refresh();
    expect(p.frames.every((f) => !('runners' in f))).toBe(true);
  });

  it('keeps every audience when the operator check fails', async () => {
    const l = loader();
    const hub = new RunnerHub({ load: l.load, resolveOperators: async () => { throw new Error('down'); } });
    const p = fakePeer();
    await hub.subscribe(p.peer, grant({ audience: 'operator' }));
    l.setFree(0);
    await hub.refresh();
    expect(p.frames.at(-1)).toHaveProperty('runners');
  });

  it('evicts and closes someone who left the org', async () => {
    const l = loader();
    const hub = new RunnerHub({ load: l.load, resolveRole: async () => new Map() });
    const p = fakePeer();
    await hub.subscribe(p.peer, grant());
    await hub.refresh();

    expect(p.frames.at(-1)).toEqual({ k: 'revoked', reason: 'no-longer-a-member' });
    expect(p.peer.close).toHaveBeenCalled();
    expect(hub.stats().peers).toBe(0);
  });

  it('keeps everyone when the role check fails, and still refreshes', async () => {
    const l = loader();
    const hub = new RunnerHub({ load: l.load, resolveRole: async () => { throw new Error('down'); } });
    const p = fakePeer();
    await hub.subscribe(p.peer, grant());
    l.setFree(0);
    await hub.refresh();
    expect(hub.stats().peers).toBe(1);
    expect(p.frames).toHaveLength(2);
  });

  it('stops sending after unsubscribe', async () => {
    const l = loader();
    const hub = new RunnerHub({ load: l.load });
    const p = fakePeer();
    await hub.subscribe(p.peer, grant());
    hub.unsubscribe(p.peer);
    l.setFree(0);
    await hub.refresh();
    expect(p.frames).toHaveLength(1);
  });

  it('derives the audience from operator status alone, never from an org role', () => {
    expect(audienceFor(true)).toBe('operator');
    expect(audienceFor(false)).toBe('member');
  });

  it('exposes no way to join a room from a raw string', () => {
    const source = readFileSync(join(__dirname, '../../server/runners/runner-hub.ts'), 'utf8');
    expect(source).toMatch(/function roomKey\(grant: RunnersGrant\): string/);
    expect(source).not.toMatch(/export function roomKey/);
  });

  it('never lets the runners socket handler make an authorisation decision of its own', () => {
    const source = readFileSync(join(__dirname, '../../server/routes/_ws/runners.ts'), 'utf8');
    expect(source).not.toMatch(/requirePermission|requireOrgRole|createRepos/);
    expect(source).toMatch(/useRunnersTicketStore\(\)\.redeem\(/);
    // A run-stream ticket must not open this socket: it redeems from its own store.
    expect(source).not.toMatch(/useTicketStore\(/);
  });
});

