<script setup lang="ts">
import type { TableView } from '~/utils/run-reducer'

defineProps<{ tables: TableView[] }>()

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const full = new Intl.NumberFormat()
</script>

<template>
  <section class="grid" aria-labelledby="tables-heading">
    <header class="head">
      <h2 id="tables-heading" class="mv-label">Tables</h2>
      <span class="count mv-num">{{ tables.filter((t) => t.status === 'done').length }} / {{ tables.length }}</span>
    </header>

    <p v-if="tables.length === 0" class="empty">
      Waiting for the load order — tables appear once the plan is ready.
    </p>

    <!-- Wide content scrolls in its own container; the page body never does. -->
    <div v-else class="mv-scroll-x">
      <table class="rows">
      <caption class="sr">Per-table copy progress</caption>
        <thead>
        <tr>
          <th scope="col" class="mv-label">Table</th>
          <th scope="col" class="mv-label num">Rows</th>
          <th scope="col" class="mv-label bar-col">Progress</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="table in tables" :key="table.tableName" :class="table.status">
          <th scope="row" class="name mv-mono">
            <StatusDot :status="table.status === 'done' ? 'ok' : table.status === 'failed' ? 'failed' : table.status === 'running' ? 'running' : 'idle'" />
            {{ table.tableName }}
          </th>
          <td class="num mv-num" :title="`${full.format(table.rowsDone)} of ${full.format(table.rowsTotal)}`">
            {{ compact.format(table.rowsDone) }}<span class="of">/{{ compact.format(table.rowsTotal) }}</span>
          </td>
          <td class="bar-col">
            <span class="bar">
              <!-- scaleX so the fill animates on the compositor, never on width. -->
              <span class="fill" :style="{ transform: `scaleX(${Math.min(table.pct, 100) / 100})` }" />
            </span>
            <span class="pct mv-num">{{ Math.round(table.pct) }}%</span>
          </td>
        </tr>
        </tbody>
      </table>
    </div>

    <p v-for="table in tables.filter((t) => t.error)" :key="`${table.tableName}-err`" class="failure">
      <strong class="mv-mono">{{ table.tableName }}</strong>
      <span class="mv-mono">{{ table.error }}</span>
    </p>
  </section>
</template>

<style scoped>
.grid { display: flex; flex-direction: column; gap: var(--mv-s-3); min-width: 0; }
.head { display: flex; align-items: baseline; justify-content: space-between; }
.count { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }

.empty {
  padding: var(--mv-s-4);
  border: 1px dashed var(--mv-line);
  border-radius: var(--mv-r-md);
  font-size: var(--mv-fs-xs);
  color: var(--mv-fg-subtle);
}

.rows { width: 100%; min-width: 320px; border-collapse: collapse; }
th, td { text-align: left; padding: 0 var(--mv-s-3); }
thead th { padding-bottom: var(--mv-s-2); border-bottom: 1px solid var(--mv-line); }
thead th:first-child, tbody th { padding-left: 0; }

tbody tr { height: var(--mv-row-h); border-bottom: 1px solid var(--mv-line); }
tbody tr:last-child { border-bottom: none; }

.name {
  display: flex; align-items: center; gap: var(--mv-s-2);
  font-size: var(--mv-fs-xs); font-weight: var(--mv-fw-regular);
  color: var(--mv-fg-muted); white-space: nowrap;
}
tbody tr.running .name, tbody tr.failed .name { color: var(--mv-fg); }

.num { font-size: var(--mv-fs-xs); color: var(--mv-fg-muted); white-space: nowrap; }
.of { color: var(--mv-fg-subtle); }

.bar-col { width: 45%; }
td.bar-col { display: flex; align-items: center; gap: var(--mv-s-3); height: var(--mv-row-h); }
.bar {
  flex: 1; min-width: 60px; height: 4px;
  border-radius: var(--mv-r-pill);
  background: var(--mv-bg-overlay);
  overflow: hidden;
}
.fill {
  display: block; height: 100%; width: 100%;
  background: var(--mv-fg-subtle);
  transform-origin: left;
  transition: transform var(--mv-dur-2) var(--mv-ease-out);
}
tbody tr.running .fill { background: var(--mv-accent); }
tbody tr.done .fill { background: var(--mv-ok); }
tbody tr.failed .fill { background: var(--mv-danger); }

.pct { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); width: 34px; text-align: right; }

.failure {
  display: flex; flex-direction: column; gap: 2px;
  padding: var(--mv-s-3);
  border: 1px solid var(--mv-danger); border-radius: var(--mv-r-md);
  background: var(--mv-danger-dim); font-size: var(--mv-fs-xs);
}
.failure strong { color: var(--mv-danger); }
.failure span { color: var(--mv-fg-muted); word-break: break-word; }

.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }

@media (max-width: 720px) {
  .bar-col { width: auto; }
  .pct { width: 30px; }
}
</style>
