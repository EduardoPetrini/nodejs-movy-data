<script setup lang="ts">
import type { LogLine } from '~/utils/run-reducer'

const props = defineProps<{ lines: LogLine[]; withheld: boolean }>()

const pane = ref<HTMLElement | null>(null)
/** Follow the tail only while the reader is already at it. */
const following = ref(true)

function onScroll() {
  const el = pane.value
  if (!el) return
  following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 32
}

watch(
  () => props.lines.length,
  async () => {
    if (!following.value) return
    await nextTick()
    const el = pane.value
    // Instant, not smooth: a smooth scroll cannot keep up with a busy run and
    // ends up permanently chasing the tail.
    if (el) el.scrollTop = el.scrollHeight
  }
)

/**
 * Local time, not the ISO string's UTC. Slicing the timestamp was showing log
 * lines four hours away from the run's own "started at", which reads as a bug
 * in the run rather than a bug in the formatting.
 */
const clock = new Intl.DateTimeFormat(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
const time = (at: string) => clock.format(new Date(at))
</script>

<template>
  <section class="logs" aria-labelledby="logs-heading">
    <header class="head">
      <h2 id="logs-heading" class="mv-label">Log</h2>
      <button v-if="!following" class="jump" @click="following = true; pane && (pane.scrollTop = pane.scrollHeight)">
        Jump to latest
      </button>
      <span v-else class="count mv-num">{{ lines.length }}</span>
    </header>

    <!-- Explains the empty pane rather than leaving it looking broken. -->
    <p v-if="withheld" class="withheld">
      Log lines are not shown for your role. They can quote SQL and table names.
    </p>

    <div v-else ref="pane" class="pane mv-mono" tabindex="0" role="log" aria-live="polite" @scroll="onScroll">
      <p v-if="lines.length === 0" class="empty">No log output yet.</p>
      <p v-for="line in lines" :key="line.seq" class="line" :class="line.level">
        <span class="at mv-num">{{ time(line.at) }}</span>
        <span class="lvl">{{ line.level }}</span>
        <span class="msg">{{ line.message }}</span>
      </p>
    </div>
  </section>
</template>

<style scoped>
.logs { display: flex; flex-direction: column; gap: var(--mv-s-3); min-height: 0; }
.head { display: flex; align-items: baseline; justify-content: space-between; }
.count { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }

.jump {
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-sm);
  background: var(--mv-bg-raised); color: var(--mv-fg-muted);
  font-size: var(--mv-fs-micro); padding: 2px var(--mv-s-2); cursor: pointer;
}
.jump:hover { border-color: var(--mv-line-strong); color: var(--mv-fg); }

.withheld,
.empty {
  padding: var(--mv-s-4);
  border: 1px dashed var(--mv-line); border-radius: var(--mv-r-md);
  font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle);
}

.pane {
  flex: 1; min-height: 200px; max-height: 460px;
  overflow-y: auto; overflow-x: auto;
  padding: var(--mv-s-3);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-sunken);
  font-size: var(--mv-fs-xs); line-height: var(--mv-lh-log);
}
.pane .empty { border: none; padding: 0; }

.line { display: flex; gap: var(--mv-s-3); white-space: pre; color: var(--mv-fg-muted); }
.at { color: var(--mv-fg-subtle); flex: none; }
.lvl { flex: none; width: 40px; color: var(--mv-fg-subtle); text-transform: uppercase; font-size: var(--mv-fs-micro); }
.msg { min-width: 0; }

.line.warn .lvl, .line.warn .msg { color: var(--mv-warn); }
.line.error .lvl, .line.error .msg { color: var(--mv-danger); }
.line.debug { color: var(--mv-fg-subtle); }
</style>
