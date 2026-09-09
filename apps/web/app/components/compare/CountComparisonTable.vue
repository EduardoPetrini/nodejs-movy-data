<script setup lang="ts">
import type { WireTableCount } from '#shared/validation-wire'

/**
 * Two counts per table, and a diverging bar centred on 100%.
 *
 * Centred rather than filled from the left because the question is not "how
 * far did it get" but "did it land on the number" — and a bar that fills
 * left-to-right makes 99.9% look like success at a glance, which is exactly
 * the case this table exists to catch.
 *
 * The mismatch filter defaults ON when anything mismatched. Someone opening a
 * failed comparison wants the four rows that are wrong, not to scroll past
 * four hundred that are right; someone opening a clean one has nothing to
 * filter and sees everything.
 */
const props = defineProps<{ tables: WireTableCount[]; allMatch: boolean }>()

const mismatchOnly = ref(!props.allMatch)
const num = new Intl.NumberFormat()

const mismatched = computed(() => props.tables.filter((t) => t.matchPct < 100))
const shown = computed(() => (mismatchOnly.value ? mismatched.value : props.tables))

/**
 * Half-width of the bar, as a percentage of the half-track.
 *
 * Clamped at 100 in both directions: a destination with MORE rows than its
 * source is a real outcome — a re-run that appended instead of replacing —
 * and it must be visible as an overshoot rather than silently clipped to a
 * full bar that reads as "matched".
 */
function bar(t: WireTableCount): { side: 'under' | 'over' | 'match'; pct: number } {
  if (t.matchPct === 100) return { side: 'match', pct: 0 }
  if (t.matchPct < 100) return { side: 'under', pct: Math.min(100, 100 - t.matchPct) }
  return { side: 'over', pct: Math.min(100, t.matchPct - 100) }
}

const pct = (value: number): string => (value === 100 ? '100%' : `${value.toFixed(3)}%`)
</script>

<template>
  <section class="compare" aria-labelledby="counts-heading">
    <header class="head">
      <h3 id="counts-heading" class="mv-label">Row counts</h3>
      <label v-if="mismatched.length" class="filter">
        <input v-model="mismatchOnly" type="checkbox" >
        Mismatches only ({{ mismatched.length }})
      </label>
    </header>

    <p v-if="tables.length === 0" class="empty">No tables were compared.</p>
    <p v-else-if="shown.length === 0" class="empty">Every table matched.</p>

    <div v-else class="scroller">
      <table class="grid">
        <thead>
          <tr>
            <th scope="col">Table</th>
            <th scope="col" class="right">Source</th>
            <th scope="col" class="right">Destination</th>
            <th scope="col" class="right">Match</th>
            <th scope="col" class="barcol"><span class="sr-only">Difference</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in shown" :key="t.tableName" :class="{ off: t.matchPct !== 100 }">
            <td class="mv-mono name">{{ t.tableName }}</td>
            <td class="right mv-num">{{ num.format(t.sourceCount) }}</td>
            <td class="right mv-num">{{ num.format(t.destCount) }}</td>
            <td class="right mv-num match">{{ pct(t.matchPct) }}</td>
            <td class="barcol">
              <span class="track" aria-hidden="true">
                <span
                  class="fill"
                  :class="bar(t).side"
                  :style="{ width: `${bar(t).pct / 2}%` }"
                />
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.compare { display: flex; flex-direction: column; gap: var(--mv-s-3); }
.head { display: flex; align-items: center; justify-content: space-between; gap: var(--mv-s-3); }
.filter {
  display: flex; align-items: center; gap: var(--mv-s-2);
  font-size: var(--mv-fs-xs); color: var(--mv-fg-muted); cursor: pointer;
}
.filter input { accent-color: var(--mv-accent); }
.filter:focus-within { color: var(--mv-fg); }

.empty {
  padding: var(--mv-s-4); border: 1px dashed var(--mv-line); border-radius: var(--mv-r-md);
  font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle);
}

.scroller { overflow-x: auto; }
.grid { width: 100%; border-collapse: collapse; font-size: var(--mv-fs-xs); }
.grid th {
  text-align: left; padding: 4px var(--mv-s-2);
  font-size: var(--mv-fs-micro); text-transform: uppercase;
  letter-spacing: var(--mv-track-label); color: var(--mv-fg-subtle);
  border-bottom: 1px solid var(--mv-line);
}
.grid td {
  padding: 0 var(--mv-s-2); height: var(--mv-row-h);
  border-bottom: 1px solid var(--mv-line); white-space: nowrap;
}
.right { text-align: right; }
.name { max-width: 34ch; overflow: hidden; text-overflow: ellipsis; }
.match { color: var(--mv-fg-subtle); }
.off .match { color: var(--mv-warn); font-weight: var(--mv-fw-medium); }

/* The bar is centred: 100% is the middle line, short is left, over is right. */
.barcol { width: 120px; min-width: 120px; }
.track {
  position: relative; display: block; height: 2px;
  background: var(--mv-line); border-radius: var(--mv-r-pill);
}
.fill {
  position: absolute; top: 0; height: 2px; border-radius: var(--mv-r-pill);
  transition: width var(--mv-dur-2) var(--mv-ease-out);
}
.fill.under { right: 50%; background: var(--mv-warn); }
.fill.over { left: 50%; background: var(--mv-accent); }
.fill.match { width: 0 !important; }

.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}

@media (max-width: 720px) {
  .barcol { display: none; }
}
</style>
