/**
 * Column sorting for the lists a reader may re-order. Pure, so the ordering
 * rules are testable without a browser.
 *
 * Two of those rules are load-bearing and neither is obvious.
 *
 * `sortRows` returns a NEW array. Its input comes from `useFetch`, which hands
 * back the same object on every render; `Array.prototype.sort` would reorder
 * the fetch cache in place, so a later `refresh()` would diff against a list
 * the server never sent.
 *
 * The string comparator pins its locale, for the same reason the date
 * formatter does. `localeCompare` with no locale resolves against Node's
 * locale on the server and the browser's on the client, and a row ORDER that
 * differs between the two halves is a hydration mismatch — one that only shows
 * up for the readers whose locale happens to disagree.
 */

export type SortDirection = 'asc' | 'desc';

/** What a column reduces a row to. `null` means the row has no value at all. */
export type SortValue = string | number | null;

export interface SortState<Key extends string = string> {
  key: Key;
  direction: SortDirection;
}

export interface SortColumn<Row, Key extends string = string> {
  key: Key;
  /** The direction this column takes when it is first clicked. */
  defaultDirection: SortDirection;
  value: (row: Row) => SortValue;
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * Rows with no value sort last in BOTH directions.
 *
 * A connection that has never been tested is not older than every tested one;
 * it is absent. Letting the direction flip it to the top would read as the most
 * recent test rather than as no test at all.
 */
function compare(a: SortValue, b: SortValue, direction: SortDirection): number {
  if (a === null || b === null) {
    if (a === b) return 0;
    return a === null ? 1 : -1;
  }

  const ordered =
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : collator.compare(String(a), String(b));

  return direction === 'asc' ? ordered : -ordered;
}

export function sortRows<Row, Key extends string>(
  rows: readonly Row[],
  columns: readonly SortColumn<Row, Key>[],
  state: SortState<Key>
): Row[] {
  const column = columns.find((c) => c.key === state.key);
  // An unknown key is the server's order, not an exception: a stale sort
  // preference must not blank a list.
  if (!column) return [...rows];

  return rows
    .map((row, index) => ({ row, index, value: column.value(row) }))
    .sort((a, b) => compare(a.value, b.value, state.direction) || a.index - b.index)
    .map((entry) => entry.row);
}

/**
 * Clicking the active column flips it; clicking another starts that column at
 * its own default — descending for a date, ascending for a name — because
 * "sort by created" nearly always means "newest first".
 */
export function nextSort<Row, Key extends string>(
  current: SortState<Key>,
  columns: readonly SortColumn<Row, Key>[],
  key: Key
): SortState<Key> {
  if (current.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { key, direction: columns.find((c) => c.key === key)?.defaultDirection ?? 'asc' };
}

/** The `aria-sort` a header cell carries, so a screen reader hears the order. */
export function ariaSort<Key extends string>(
  state: SortState<Key>,
  key: Key
): 'ascending' | 'descending' | 'none' {
  if (state.key !== key) return 'none';
  return state.direction === 'asc' ? 'ascending' : 'descending';
}

/** A timestamp as a sortable number. Absent or unparseable is `null`, not 0. */
export function timeValue(iso: string | null | undefined): SortValue {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}
