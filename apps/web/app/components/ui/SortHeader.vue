<script setup lang="ts">
import type { SortDirection } from '../../utils/table-sort'

/**
 * The clickable part of a sortable column heading.
 *
 * `aria-sort` belongs on the `<th>`, not here — it describes the column, while
 * this button is the control that changes it. Every call site therefore binds
 * both: `:aria-sort` on the cell, this component inside it.
 */
defineProps<{ label: string; direction?: SortDirection }>()
defineEmits<{ toggle: [] }>()
</script>

<template>
  <button type="button" class="sortHeader" :class="{ active: !!direction }" @click="$emit('toggle')">
    <span class="mv-label">{{ label }}</span>
    <!-- Decorative: the order is announced by the cell's aria-sort. -->
    <span class="caret" aria-hidden="true">{{ direction === 'asc' ? '↑' : direction === 'desc' ? '↓' : '↕' }}</span>
  </button>
</template>

<style scoped>
.sortHeader {
  display: inline-flex;
  align-items: center;
  gap: var(--mv-s-1);
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  transition: color var(--mv-dur-1) var(--mv-ease-out);
}
.sortHeader .mv-label { transition: color var(--mv-dur-1) var(--mv-ease-out); }
.sortHeader:hover .mv-label { color: var(--mv-fg-muted); }
.sortHeader.active .mv-label { color: var(--mv-fg); }
.sortHeader:focus-visible { box-shadow: var(--mv-focus); }

/*
 * The inactive caret is neutral and holds its space rather than appearing on
 * hover: a column heading that shifts sideways under the pointer is harder to
 * hit than one that does not, and an arrow shown before a click would promise
 * a direction this component cannot know.
 */
.caret {
  font-size: var(--mv-fs-micro);
  line-height: 1;
  color: var(--mv-accent);
  opacity: 0;
  transition: opacity var(--mv-dur-1) var(--mv-ease-out);
}
.sortHeader:hover .caret { opacity: 0.4; }
.sortHeader.active .caret { opacity: 1; }
</style>
