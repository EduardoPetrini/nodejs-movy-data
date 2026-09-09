import { describe, it, expect } from 'vitest';
import {
  ariaSort,
  nextSort,
  sortRows,
  timeValue,
  type SortColumn,
  type SortState,
} from '../../app/utils/table-sort';

interface Row {
  name: string;
  createdAt: string;
  lastTestAt: string | null;
}

type Key = 'name' | 'createdAt' | 'lastTest';

const columns: SortColumn<Row, Key>[] = [
  { key: 'name', defaultDirection: 'asc', value: (r) => r.name },
  { key: 'createdAt', defaultDirection: 'desc', value: (r) => timeValue(r.createdAt) },
  { key: 'lastTest', defaultDirection: 'desc', value: (r) => timeValue(r.lastTestAt) },
];

const row = (name: string, createdAt: string, lastTestAt: string | null = null): Row => ({
  name,
  createdAt,
  lastTestAt,
});

const names = (rows: readonly Row[]) => rows.map((r) => r.name);

describe('sortRows', () => {
  it('orders newest first when a date column is descending', () => {
    const rows = [
      row('middle', '2026-03-02T10:00:00.000Z'),
      row('oldest', '2025-01-01T10:00:00.000Z'),
      row('newest', '2026-09-09T10:00:00.000Z'),
    ];

    const sorted = sortRows(rows, columns, { key: 'createdAt', direction: 'desc' });

    expect(names(sorted)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('orders oldest first when the same column is ascending', () => {
    const rows = [
      row('middle', '2026-03-02T10:00:00.000Z'),
      row('oldest', '2025-01-01T10:00:00.000Z'),
      row('newest', '2026-09-09T10:00:00.000Z'),
    ];

    const sorted = sortRows(rows, columns, { key: 'createdAt', direction: 'asc' });

    expect(names(sorted)).toEqual(['oldest', 'middle', 'newest']);
  });

  it('compares names case-insensitively and numerically', () => {
    // 'conn10' must not land between 'conn1' and 'conn2', and a capital must
    // not sort a whole block ahead of the lowercase names beside it.
    const rows = [
      row('conn10', '2026-01-01T00:00:00.000Z'),
      row('Conn2', '2026-01-01T00:00:00.000Z'),
      row('conn1', '2026-01-01T00:00:00.000Z'),
    ];

    const sorted = sortRows(rows, columns, { key: 'name', direction: 'asc' });

    expect(names(sorted)).toEqual(['conn1', 'Conn2', 'conn10']);
  });

  /**
   * A connection that has never been tested is absent, not oldest. Flipping it
   * to the top on the descending click would read as the most recent test.
   */
  it('keeps rows with no value last in both directions', () => {
    const rows = [
      row('never', '2026-01-01T00:00:00.000Z', null),
      row('tested', '2026-01-01T00:00:00.000Z', '2026-05-05T00:00:00.000Z'),
      row('tested-earlier', '2026-01-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z'),
    ];

    expect(names(sortRows(rows, columns, { key: 'lastTest', direction: 'desc' }))).toEqual([
      'tested',
      'tested-earlier',
      'never',
    ]);
    expect(names(sortRows(rows, columns, { key: 'lastTest', direction: 'asc' }))).toEqual([
      'tested-earlier',
      'tested',
      'never',
    ]);
  });

  it('holds the incoming order for rows that tie', () => {
    const sameInstant = '2026-04-04T00:00:00.000Z';
    const rows = [row('b', sameInstant), row('a', sameInstant), row('c', sameInstant)];

    expect(names(sortRows(rows, columns, { key: 'createdAt', direction: 'desc' }))).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  /**
   * The rows come from `useFetch`, which hands back the same object every
   * render. Sorting in place would reorder the fetch cache itself.
   */
  it('never reorders the array it was given', () => {
    const rows = [row('b', '2025-01-01T00:00:00.000Z'), row('a', '2026-01-01T00:00:00.000Z')];
    const before = names(rows);

    const sorted = sortRows(rows, columns, { key: 'createdAt', direction: 'desc' });

    expect(names(rows)).toEqual(before);
    expect(sorted).not.toBe(rows);
  });

  it('falls back to the incoming order for a key it does not know', () => {
    const rows = [row('b', '2025-01-01T00:00:00.000Z'), row('a', '2026-01-01T00:00:00.000Z')];

    const sorted = sortRows(rows, columns, { key: 'gone' as Key, direction: 'desc' });

    expect(names(sorted)).toEqual(['b', 'a']);
  });
});

describe('timeValue', () => {
  it('is null rather than zero for an absent or unparseable timestamp', () => {
    expect(timeValue(null)).toBeNull();
    expect(timeValue(undefined)).toBeNull();
    expect(timeValue('')).toBeNull();
    expect(timeValue('not a date')).toBeNull();
  });

  it('is the epoch milliseconds of a real one', () => {
    expect(timeValue('2026-09-09T10:00:00.000Z')).toBe(Date.parse('2026-09-09T10:00:00.000Z'));
  });
});

describe('nextSort', () => {
  const createdDesc: SortState<Key> = { key: 'createdAt', direction: 'desc' };

  it('flips the column that is already sorted', () => {
    expect(nextSort(createdDesc, columns, 'createdAt')).toEqual({
      key: 'createdAt',
      direction: 'asc',
    });
  });

  it("starts another column at that column's own default", () => {
    // Dates want newest first; names want A first. One click, the expected order.
    expect(nextSort(createdDesc, columns, 'name')).toEqual({ key: 'name', direction: 'asc' });
    expect(nextSort({ key: 'name', direction: 'asc' }, columns, 'createdAt')).toEqual({
      key: 'createdAt',
      direction: 'desc',
    });
  });
});

describe('ariaSort', () => {
  it('describes only the column that is actually sorted', () => {
    const state: SortState<Key> = { key: 'createdAt', direction: 'desc' };
    expect(ariaSort(state, 'createdAt')).toBe('descending');
    expect(ariaSort({ ...state, direction: 'asc' }, 'createdAt')).toBe('ascending');
    expect(ariaSort(state, 'name')).toBe('none');
  });
});
