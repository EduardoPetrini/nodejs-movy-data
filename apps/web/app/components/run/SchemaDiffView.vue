<script setup lang="ts">
import type { PreviewDiffCounts, PreviewTypeChange } from '#shared/definition-wire'

/**
 * What the destination is missing, relative to the source.
 *
 * The same view before and after a migration, which is the point of pulling it
 * out of `PreviewPanel`: on the review screen it reads as "what this run will
 * change", and on the compare page as "what a run has NOT applied". Two
 * screens describing the same seven numbers in two layouts is how they end up
 * disagreeing about which seven.
 *
 * An all-zero diff is the answer, not an empty state — "the schemas match" is
 * precisely what someone opening the compare page wants to be told.
 */
const props = defineProps<{
  diff: PreviewDiffCounts
  typeChanges: PreviewTypeChange[]
  /** Tables the destination has that the source does not. Left untouched by a run. */
  extraTables?: string[]
  /** Names the diff's direction in one sentence. */
  caption?: string
}>()

const entries = computed(() => [
  { label: 'Tables to create', value: props.diff.tablesToCreate },
  { label: 'Columns to add', value: props.diff.columnsToAdd },
  { label: 'Columns to alter', value: props.diff.columnsToAlter },
  { label: 'Constraints', value: props.diff.constraintsToAdd },
  { label: 'Indexes', value: props.diff.indexesToCreate },
  { label: 'Sequences', value: props.diff.sequencesToCreate },
  { label: 'Enums', value: props.diff.enumsToCreate },
])

const identical = computed(
  () => entries.value.every((e) => e.value === 0) && props.typeChanges.length === 0
)
</script>

<template>
  <div class="diff">
    <p v-if="caption" class="caption">{{ caption }}</p>

    <p v-if="identical" class="match">
      <span class="tick" aria-hidden="true" />
      The two schemas match. Nothing would be created or altered.
    </p>

    <dl class="counts">
      <div v-for="entry in entries" :key="entry.label" :class="{ zero: entry.value === 0 }">
        <dt>{{ entry.label }}</dt>
        <dd class="mv-num">{{ entry.value }}</dd>
      </div>
    </dl>

    <details v-if="typeChanges.length" class="drawer">
      <summary>{{ typeChanges.length }} columns change type</summary>
      <div class="scroller">
        <table class="grid">
          <thead>
            <tr><th>Column</th><th>From</th><th>To</th></tr>
          </thead>
          <tbody>
            <tr v-for="c in typeChanges" :key="`${c.tableName}.${c.columnName}`">
              <td class="mv-mono">{{ c.tableName }}.{{ c.columnName }}</td>
              <td class="mv-mono from">{{ c.sourceType }}</td>
              <td class="mv-mono to">{{ c.targetType }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>

    <details v-if="extraTables?.length" class="drawer">
      <summary>{{ extraTables.length }} tables in the destination Movy will not touch</summary>
      <p class="note mv-mono">{{ extraTables.join(', ') }}</p>
    </details>
  </div>
</template>

<style scoped>
.diff { display: flex; flex-direction: column; gap: var(--mv-s-3); }
.caption { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }

.match {
  display: flex; align-items: center; gap: var(--mv-s-2);
  padding: var(--mv-s-3); border-radius: var(--mv-r-md);
  border-left: 2px solid var(--mv-ok);
  background: var(--mv-bg-raised);
  font-size: var(--mv-fs-sm);
}
.tick { width: 6px; height: 6px; flex: none; border-radius: var(--mv-r-pill); background: var(--mv-ok); }

.counts { display: flex; flex-wrap: wrap; gap: var(--mv-s-5); margin: 0; }
.counts div { display: flex; flex-direction: column; gap: 2px; }
.counts dt {
  font-size: var(--mv-fs-micro); text-transform: uppercase;
  letter-spacing: var(--mv-track-label); color: var(--mv-fg-subtle);
}
.counts dd { margin: 0; font-size: var(--mv-fs-md); font-variant-numeric: var(--mv-numeric); }
/* A zero recedes rather than disappearing: the reader still learns it was asked. */
.counts .zero dd { color: var(--mv-fg-subtle); }

.drawer { border-top: 1px solid var(--mv-line); padding-top: var(--mv-s-3); }
.drawer summary {
  cursor: pointer; font-size: var(--mv-fs-xs); color: var(--mv-fg-muted);
  transition: color var(--mv-dur-1) var(--mv-ease-out);
}
.drawer summary:hover { color: var(--mv-fg); }
.drawer summary:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 2px; }

/* Wide content scrolls inside its own box; the page never scrolls sideways. */
.scroller { overflow-x: auto; }
.grid { width: 100%; border-collapse: collapse; margin-top: var(--mv-s-3); font-size: var(--mv-fs-xs); }
.grid th {
  text-align: left; padding: 4px var(--mv-s-2);
  font-size: var(--mv-fs-micro); text-transform: uppercase;
  letter-spacing: var(--mv-track-label); color: var(--mv-fg-subtle);
  border-bottom: 1px solid var(--mv-line);
}
.grid td { padding: 4px var(--mv-s-2); border-bottom: 1px solid var(--mv-line); white-space: nowrap; }
.from { color: var(--mv-fg-subtle); }
.to { color: var(--mv-accent); }

.note {
  margin-top: var(--mv-s-3);
  font-size: var(--mv-fs-micro); color: var(--mv-fg-subtle); word-break: break-word;
}
</style>
