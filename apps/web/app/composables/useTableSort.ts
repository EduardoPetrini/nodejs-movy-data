import {
  ariaSort,
  nextSort,
  sortRows,
  type SortColumn,
  type SortDirection,
  type SortState,
} from '../utils/table-sort'

/**
 * Reactive wrapper around the pure sorter in `utils/table-sort`.
 *
 * All of the ordering lives there; this holds the one piece of state a table
 * needs and nothing else, so a page gets a sortable column in three lines and
 * both pages get the same behaviour on a click.
 */
export function useTableSort<Row, Key extends string>(
  rows: Ref<readonly Row[]> | ComputedRef<readonly Row[]>,
  columns: readonly SortColumn<Row, Key>[],
  initial: SortState<Key>
) {
  const state = ref(initial) as Ref<SortState<Key>>

  return {
    state,
    sorted: computed(() => sortRows(rows.value, columns, state.value)),
    toggle(key: Key) {
      state.value = nextSort(state.value, columns, key)
    },
    /** The active direction, or undefined when this is not the sorted column. */
    directionFor: (key: Key): SortDirection | undefined =>
      state.value.key === key ? state.value.direction : undefined,
    ariaSortFor: (key: Key) => ariaSort(state.value, key),
  }
}
