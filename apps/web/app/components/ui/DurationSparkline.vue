<script setup lang="ts">
/**
 * A definition's last few run durations, 40x12.
 *
 * Inline SVG rather than a chart library: it is one polyline, and pulling a
 * charting dependency into a landing page's bundle to draw forty pixels is the
 * kind of thing the performance budget exists to stop.
 *
 * Read left-to-right as then-to-now. A single run draws a dot rather than a
 * flat line, because a flat line reads as "stable over time" and one
 * observation is not a trend.
 */
const props = withDefaults(
  defineProps<{
    /** Milliseconds, oldest first. */
    values: number[]
    label?: string
    width?: number
    height?: number
  }>(),
  { width: 40, height: 12, label: 'Recent run durations' }
)

const PAD = 1

const points = computed(() => {
  const values = props.values
  if (values.length === 0) return []

  const max = Math.max(...values)
  const min = Math.min(...values)
  // A constant series has no range to scale against; dividing by zero would
  // put every point at NaN and draw nothing at all. Centred is the truth: it
  // did not vary.
  const span = max - min || 1
  const usableW = props.width - PAD * 2
  const usableH = props.height - PAD * 2
  const step = values.length > 1 ? usableW / (values.length - 1) : 0

  return values.map((value, i) => ({
    x: PAD + (values.length > 1 ? i * step : usableW / 2),
    // SVG y grows downward, so a slower run — a larger number — sits higher up
    // the page only if we invert it here.
    y: PAD + usableH - ((value - min) / span) * usableH,
  }))
})

const path = computed(() => points.value.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '))
const last = computed(() => points.value[points.value.length - 1])

const summary = computed(() => {
  if (props.values.length === 0) return 'No completed runs yet'
  const latest = props.values[props.values.length - 1] ?? 0
  return `${props.label}: ${props.values.length} runs, most recent ${formatMs(latest)}`
})

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
}
</script>

<template>
  <svg
    v-if="values.length"
    class="spark"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    role="img"
    :aria-label="summary"
    preserveAspectRatio="none"
  >
    <polyline v-if="values.length > 1" :points="path" fill="none" stroke-linejoin="round" stroke-linecap="round" />
    <circle v-if="last" :cx="last.x" :cy="last.y" r="1.5" />
  </svg>
  <!-- An empty slot rather than nothing, so a row with no history keeps its
       column alignment with every row that has one. -->
  <span v-else class="spark empty" :aria-label="summary" role="img" />
</template>

<style scoped>
.spark { flex: none; display: block; overflow: visible; }
.spark polyline { stroke: var(--mv-fg-subtle); stroke-width: 1; }
.spark circle { fill: var(--mv-accent); }
.spark.empty { width: 40px; height: 12px; }
</style>
