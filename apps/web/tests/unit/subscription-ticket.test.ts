import { describe, it, expect } from 'vitest';
import { TicketStore } from '../../server/runs/subscription-ticket';
import type { SubscriptionGrant } from '../../server/runs/run-hub';

const GRANT: SubscriptionGrant = {
  userId: 'aaaaaaaa-0000-0000-0000-000000000001',
  orgId: 'bbbbbbbb-0000-0000-0000-000000000002',
  runId: 'cccccccc-0000-0000-0000-000000000003',
  cohort: 'full',
};

describe('TicketStore', () => {
  it('round-trips the grant exactly', () => {
    const store = new TicketStore();
    const { ticket } = store.mint(GRANT);
    expect(store.redeem(ticket)).toEqual(GRANT);
  });

  it('redeems once and only once', () => {
    // A ticket that leaks — a proxy log, a screenshot — is already spent.
    const store = new TicketStore();
    const { ticket } = store.mint(GRANT);

    expect(store.redeem(ticket)).toEqual(GRANT);
    expect(store.redeem(ticket)).toBeNull();
  });

  it('is still good just before its deadline, and dead just after', () => {
    let now = 1_000_000;
    const store = new TicketStore({ ttlMs: 5_000, now: () => now });

    const stillValid = store.mint(GRANT).ticket;
    now += 4_999;
    expect(store.redeem(stillValid)).toEqual(GRANT);

    now = 1_000_000;
    const expired = store.mint(GRANT).ticket;
    now += 5_001;
    expect(store.redeem(expired)).toBeNull();
  });

  it('sweeps expired tickets rather than growing forever', () => {
    let now = 0;
    const store = new TicketStore({ ttlMs: 1_000, now: () => now });
    for (let i = 0; i < 5; i += 1) store.mint(GRANT);
    expect(store.size()).toBe(5);

    now += 1_001;
    expect(store.size()).toBe(0);
  });

  it('rejects anything that is not a minted ticket', () => {
    const store = new TicketStore();
    store.mint(GRANT);

    for (const bogus of [undefined, null, '', 42, {}, [], 'not-a-ticket', 'a'.repeat(43)]) {
      expect(store.redeem(bogus)).toBeNull();
    }
  });

  it('issues unguessable, unique tickets', () => {
    const store = new TicketStore();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const { ticket } = store.mint(GRANT);
      expect(ticket.length).toBeGreaterThanOrEqual(43); // 32 bytes, base64url
      expect(seen.has(ticket)).toBe(false);
      seen.add(ticket);
    }
  });

  it('does not let one ticket redeem another grant', () => {
    const store = new TicketStore();
    const other: SubscriptionGrant = { ...GRANT, orgId: 'dddddddd-0000-0000-0000-000000000004' };
    const a = store.mint(GRANT).ticket;
    const b = store.mint(other).ticket;

    expect(store.redeem(a)).toEqual(GRANT);
    expect(store.redeem(b)).toEqual(other);
  });

  it('reports the lifetime it granted, so a client knows how long it has', () => {
    const store = new TicketStore({ ttlMs: 12_345 });
    expect(store.mint(GRANT).expiresInMs).toBe(12_345);
  });
});
