<script setup lang="ts">
import type { StepView } from '~/utils/run-reducer'

const props = defineProps<{ steps: StepView[] }>()

/** The rail fills to the last step that has started. */
const progressed = computed(() => {
  const last = props.steps.reduce((acc, s, i) => (s.status === 'pending' ? acc : i), -1)
  return last < 0 ? 0 : ((last + 1) / props.steps.length) * 100
})

function duration(ms: number | null): string {
  if (ms === null) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

const detailText = (detail: unknown): string | null => {
  if (!detail || typeof detail !== 'object') return null
  const d = detail as Record<string, unknown>
  switch (d.kind) {
    case 'create_database': return d.created ? `created ${d.database}` : `${d.database} already existed`
    case 'inspect_and_diff': return `${d.sourceTables} tables, ${d.sourceSequences} sequences`
    case 'triggers': return `${d.tables} tables`
    case 'create_indexes': return `${d.indexes} indexes`
    case 'reset_sequences': return `${d.sequences} sequences`
    case 'migrate_data': return `${d.tables} tables, ${Number(d.rowsCopied).toLocaleString()} rows`
    default: return null
  }
}
</script>

<template>
  <section class="timeline" aria-labelledby="timeline-heading">
    <h2 id="timeline-heading" class="mv-label">Timeline</h2>

    <ol class="steps">
      <!-- One rail behind all nine nodes, filled to the furthest step reached.
           Scaled rather than sized so the fill animates on the compositor. -->
      <span class="rail" aria-hidden="true">
        <span class="rail-fill" :style="{ transform: `scaleY(${progressed / 100})` }" />
      </span>

      <li v-for="step in steps" :key="step.stepId" class="step" :class="step.status">
        <span class="node" aria-hidden="true" />
        <span class="main">
          <span class="label">{{ step.label }}</span>
          <span class="spacer" />
          <span v-if="step.durationMs !== null" class="time mv-num">{{ duration(step.durationMs) }}</span>
        </span>
        <!-- Detail on its own line: at this column width it would otherwise
             wrap into the next step and the rows would collide. -->
        <span v-if="detailText(step.detail)" class="detail mv-mono">{{ detailText(step.detail) }}</span>
        <span class="sr">{{ step.status }}</span>
      </li>
    </ol>

    <p v-for="step in steps.filter((s) => s.error)" :key="`${step.stepId}-error`" class="failure">
      <strong>{{ step.label }}</strong>
      <span class="mv-mono">{{ step.error?.message }}</span>
    </p>
  </section>
</template>

<style scoped>
.timeline { display: flex; flex-direction: column; gap: var(--mv-s-3); }

.steps { position: relative; list-style: none; margin: 0; padding: 0; }

.rail {
  position: absolute;
  left: var(--mv-rail-x);
  top: calc(var(--mv-row-h) / 2);
  bottom: calc(var(--mv-row-h) / 2);
  width: var(--mv-rail-w);
  background: var(--mv-line);
}
.rail-fill {
  display: block; height: 100%; width: 100%;
  background: var(--mv-accent);
  transform-origin: top;
  transition: transform var(--mv-dur-3) var(--mv-ease-out);
}

.step {
  position: relative;
  display: flex; flex-direction: column;
  /* min-height, not height: a wrapped label used to overflow a fixed row and
     collide with the step below it. */
  min-height: var(--mv-row-h);
  padding-left: calc(var(--mv-rail-x) + var(--mv-s-4));
  padding-bottom: var(--mv-s-1);
  font-size: var(--mv-fs-sm);
  color: var(--mv-fg-subtle);
}

.main { display: flex; align-items: center; gap: var(--mv-s-3); min-height: var(--mv-row-h); }

.node {
  position: absolute;
  left: calc(var(--mv-rail-x) - (var(--mv-node) / 2) + (var(--mv-rail-w) / 2));
  /* Pinned to the first line's centre, so a two-line step keeps its node
     beside the label rather than drifting down beside the detail. */
  top: calc((var(--mv-row-h) - var(--mv-node)) / 2);
  width: var(--mv-node); height: var(--mv-node);
  border-radius: var(--mv-r-pill);
  border: 1px solid var(--mv-line-strong);
  background: var(--mv-bg-base);
  transition: background var(--mv-dur-2) var(--mv-ease-out),
              border-color var(--mv-dur-2) var(--mv-ease-out);
}

.label { transition: color var(--mv-dur-2) var(--mv-ease-out); }
.detail { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); line-height: 1.35; }
.spacer { flex: 1; }
.time { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); font-variant-numeric: var(--mv-numeric); }

/* Status is carried by the node and the label weight, never by colour alone. */
.running .label { color: var(--mv-fg); font-weight: var(--mv-fw-medium); }
.running > .node {
  background: var(--mv-accent); border-color: var(--mv-accent);
  animation: breathe var(--mv-dur-4) var(--mv-ease-inout) infinite;
}
.ok .label { color: var(--mv-fg-muted); }
.ok > .node { background: var(--mv-ok); border-color: var(--mv-ok); }
.failed .label { color: var(--mv-fg); font-weight: var(--mv-fw-medium); }
.failed > .node { background: var(--mv-danger); border-color: var(--mv-danger); }
.skipped > .node { background: var(--mv-bg-overlay); border-style: dashed; }

@keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

.failure {
  display: flex; flex-direction: column; gap: 2px;
  padding: var(--mv-s-3);
  border: 1px solid var(--mv-danger);
  border-radius: var(--mv-r-md);
  background: var(--mv-danger-dim);
  font-size: var(--mv-fs-xs);
}
.failure strong { color: var(--mv-danger); font-weight: var(--mv-fw-semibold); }
.failure span { color: var(--mv-fg-muted); word-break: break-word; }

.sr {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap;
}
</style>
