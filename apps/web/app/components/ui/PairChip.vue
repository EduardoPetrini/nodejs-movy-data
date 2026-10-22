<script setup lang="ts">
/** Renders one Pair. Never the word "connector" — see CONTEXT.md. */
const props = defineProps<{ source: string; target?: string; planned?: boolean }>()
const label = (e: string) => ({ postgres: 'PostgreSQL', mysql: 'MySQL', mssql: 'SQL Server', snowflake: 'Snowflake' }[e] ?? e)
</script>

<template>
  <span class="chip" :class="{ planned }" :title="planned ? 'Planned — not yet implemented' : undefined">
    <span class="engine" :style="{ '--c': `var(--mv-engine-${source})` }">{{ label(source) }}</span>
    <template v-if="target">
      <span class="arrow" aria-label="to">→</span>
      <span class="engine" :style="{ '--c': `var(--mv-engine-${target})` }">{{ label(target) }}</span>
    </template>
  </span>
</template>

<style scoped>
.chip {
  display: inline-flex; align-items: center; gap: var(--mv-s-2);
  font-size: var(--mv-fs-xs); color: var(--mv-fg-muted);
}
.engine { display: inline-flex; align-items: center; gap: 5px; }
.engine::before {
  content: ''; width: 6px; height: 6px; border-radius: var(--mv-r-pill);
  background: var(--c, var(--mv-fg-subtle));
}
.arrow { color: var(--mv-fg-subtle); }
.planned { opacity: 0.5; }
.planned .engine::before { background: var(--mv-engine-planned); }
</style>
