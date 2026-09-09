import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../shared/keyset-cursor';
import { clampLimit, toPage } from '../../server/repositories/paging';

const AT = '2026-09-08T10:11:12.345Z';
const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('keyset cursor', () => {
  it('round-trips a position', () => {
    expect(decodeCursor(encodeCursor({ createdAt: AT, id: ID }))).toEqual({ createdAt: AT, id: ID });
  });

  it('is opaque — no timestamp or id is readable from the token', () => {
    // Not a security property; a promise that nobody builds one by hand and
    // then depends on the format.
    const token = encodeCursor({ createdAt: AT, id: ID });
    expect(token).not.toContain(AT);
    expect(token).not.toContain(ID);
  });

  it('is URL-safe, since it travels as a query parameter', () => {
    expect(encodeCursor({ createdAt: AT, id: ID })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  for (const [name, input] of [
    ['empty', ''],
    ['not a string', 42],
    ['not base64url', 'not a cursor!'],
    ['base64 of nonsense', Buffer.from('hello').toString('base64url')],
    ['a bad timestamp', Buffer.from(`never|${ID}`).toString('base64url')],
    ['a non-uuid id', Buffer.from(`${AT}|../../etc/passwd`).toString('base64url')],
    ['no separator', Buffer.from(AT).toString('base64url')],
  ] as const) {
    it(`returns undefined for ${name} rather than throwing`, () => {
      // The route turns undefined into a 400. Throwing here would make a
      // malformed cursor a 500, and guessing would make it a silent page one —
      // which loops a paging client forever.
      expect(decodeCursor(input)).toBeUndefined();
    });
  }

  it('refuses an absurdly long token without decoding it', () => {
    expect(decodeCursor('A'.repeat(5000))).toBeUndefined();
  });
});

describe('clampLimit', () => {
  it('falls back for anything that is not a usable number', () => {
    for (const input of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampLimit(input)).toBe(25);
    }
  });

  it('caps the ceiling, so one request cannot ask for the whole table', () => {
    expect(clampLimit(10_000)).toBe(100);
  });

  it('floors a fractional limit rather than passing it to LIMIT', () => {
    expect(clampLimit(7.9)).toBe(7);
  });
});

describe('toPage', () => {
  const row = (id: string, iso: string) => ({ id, createdAt: new Date(iso) });
  const key = (r: { id: string; createdAt: Date }) => r;

  it('trims the sentinel row and points the cursor at the LAST ROW RETURNED', () => {
    // Naming the sentinel would skip it: it is never sent to the client, so a
    // cursor "after" it hides one row per page, forever.
    const rows = [
      row('a', '2026-09-08T03:00:00.000Z'),
      row('b', '2026-09-08T02:00:00.000Z'),
      row('c', '2026-09-08T01:00:00.000Z'),
    ];
    const page = toPage(rows, 2, key);

    expect(page.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).toEqual({ createdAt: '2026-09-08T02:00:00.000Z', id: 'b' });
  });

  it('reports no next page when the sentinel row never came back', () => {
    const page = toPage([row('a', '2026-09-08T03:00:00.000Z')], 2, key);
    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).toBeUndefined();
  });

  it('reports no next page for an empty result', () => {
    expect(toPage([], 25, key)).toEqual({ rows: [], nextCursor: undefined });
  });

  it('produces a cursor that decodes back to the same position', () => {
    const rows = [row(ID, AT), row('11111111-1111-1111-1111-111111111111', AT)];
    const page = toPage(rows, 1, key);
    expect(decodeCursor(encodeCursor(page.nextCursor!))).toEqual({ createdAt: AT, id: ID });
  });
});
