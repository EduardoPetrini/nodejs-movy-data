<script setup lang="ts">
import { isTerminal } from '#shared/run-wire'
import type { WireRun } from '#shared/run-wire'

const props = defineProps<{ run: WireRun; live: boolean }>()

const dot = computed(() => {
  if (props.run.status === 'succeeded') return 'ok'
  if (props.run.status === 'failed') return 'failed'
  if (isTerminal(props.run.status)) return 'idle'
  return 'running'
})

/**
 * Wall clock for THIS run, not the duration on the event.
 *
 * They are the same thing for a real migration, but a replayed recording
 * reports the original run's duration — 407ms for the bundled fixture — which
 * renders as "0s" next to a replay the viewer just watched take a minute.
 */
const elapsed = computed(() => {
  const started = props.run.startedAt ? Date.parse(props.run.startedAt) : null
  if (started === null) return null
  const ended = props.run.finishedAt ? Date.parse(props.run.finishedAt) : now.value
  return format(ended - started)
})

/** Ticks only while the run is open, so a finished page is not repainting. */
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null
onMounted(() => { tick = setInterval(() => { now.value = Date.now() }, 1000) })
onBeforeUnmount(() => { if (tick) clearInterval(tick) })
watchEffect(() => { if (isTerminal(props.run.status) && tick) { clearInterval(tick); tick = null } })

function format(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

const rows = new Intl.NumberFormat()
</script>

<template>
  <header class="hd">
    <div class="top">
      <StatusDot :status="dot" />
      <h1 class="status">{{ run.status }}</h1>
      <PairChip :source="run.source.engine" :target="run.target.engine" />
      <span v-if="run.simulated" class="tag" title="Replayed from a recording — no database was touched">
        simulated
      </span>
      <span class="spacer" />
      <span v-if="!live && !isTerminal(run.status)" class="stale">reconnecting…</span>
      <slot name="actions" />
    </div>

    <dl class="facts">
      <div><dt class="mv-label">From</dt><dd class="mv-mono">{{ run.source.database }}</dd></div>
      <div><dt class="mv-label">To</dt><dd class="mv-mono">{{ run.target.database }}</dd></div>
      <div>
        <dt class="mv-label">Rows</dt>
        <dd class="mv-num">{{ rows.format(run.progress.rowsDone) }}<span class="of"> / {{ rows.format(run.progress.rowsTotal) }}</span></dd>
      </div>
      <div><dt class="mv-label">Tables</dt><dd class="mv-num">{{ run.progress.tablesDone }} / {{ run.progress.tablesTotal }}</dd></div>
      <div v-if="elapsed"><dt class="mv-label">Elapsed</dt><dd class="mv-num">{{ elapsed }}</dd></div>
    </dl>

    <!-- One hero number per screen. It is the thing you actually came to see. -->
    <div class="overall">
      <span class="pct mv-num">{{ run.progress.pct.toFixed(1) }}<em>%</em></span>
      <span class="track">
        <span class="fill" :class="dot" :style="{ transform: `scaleX(${run.progress.pct / 100})` }" />
      </span>
    </div>

    <p v-if="run.error" class="err">
      <strong>{{ run.error.name }}</strong>
      <span class="mv-mono">{{ run.error.message }}</span>
    </p>
  </header>
</template>

<style scoped>
.hd { display: flex; flex-direction: column; gap: var(--mv-s-4); }

.top { display: flex; align-items: center; gap: var(--mv-s-3); flex-wrap: wrap; }
.status { font-size: var(--mv-fs-lg); letter-spacing: -0.015em; text-transform: capitalize; }
.spacer { flex: 1; }
.tag {
  font-size: var(--mv-fs-micro); letter-spacing: var(--mv-track-label); text-transform: uppercase;
  padding: 2px 6px; border-radius: var(--mv-r-sm);
  background: var(--mv-warn-dim); color: var(--mv-warn);
}
.stale { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }

.facts { display: flex; flex-wrap: wrap; gap: var(--mv-s-5); margin: 0; }
.facts div { display: flex; flex-direction: column; gap: 2px; }
.facts dd { margin: 0; font-size: var(--mv-fs-xs); color: var(--mv-fg-muted); }
.of { color: var(--mv-fg-subtle); }

.overall { display: flex; align-items: center; gap: var(--mv-s-4); }
.pct { font-size: var(--mv-fs-hero); font-weight: var(--mv-fw-semibold); letter-spacing: -0.03em; line-height: 1; }
.pct em { font-style: normal; font-size: var(--mv-fs-md); color: var(--mv-fg-subtle); margin-left: 2px; }
.track { flex: 1; height: 6px; border-radius: var(--mv-r-pill); background: var(--mv-bg-overlay); overflow: hidden; }
.fill {
  display: block; height: 100%; width: 100%;
  transform-origin: left; background: var(--mv-accent);
  transition: transform var(--mv-dur-3) var(--mv-ease-out);
}
.fill.ok { background: var(--mv-ok); }
.fill.failed { background: var(--mv-danger); }

.err {
  display: flex; flex-direction: column; gap: 2px;
  padding: var(--mv-s-3);
  border: 1px solid var(--mv-danger); border-radius: var(--mv-r-md);
  background: var(--mv-danger-dim); font-size: var(--mv-fs-xs);
}
.err strong { color: var(--mv-danger); }
.err span { color: var(--mv-fg-muted); word-break: break-word; }
</style>
