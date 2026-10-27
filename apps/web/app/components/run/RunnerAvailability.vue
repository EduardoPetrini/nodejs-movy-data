<script setup lang="ts">
import { availabilityOf, classSentence, type ClassAvailability } from '#shared/runner-wire'
import { formatDateTime } from '../../utils/format-datetime'

/**
 * Whether a run launched now would start: per runner class, in one line.
 *
 * `rail` stacks the classes for the org home's summary rail; `inline` is one
 * strip under a page header. Admins also see the runners themselves — ids are
 * hostnames, so nobody else is sent them at all.
 */
const props = withDefaults(defineProps<{ orgSlug: string; variant?: 'rail' | 'inline' }>(), { variant: 'rail' })

const { snapshot, status } = useRunnerStatus(props.orgSlug)

const DOT: Record<ClassAvailability, 'ok' | 'running' | 'failed' | 'idle'> = {
  free: 'ok',
  busy: 'running',
  none: 'failed',
  draining: 'idle',
}

const classes = computed(() => snapshot.value?.classes ?? [])
const runners = computed(() => snapshot.value?.runners)
</script>

<template>
  <section
    v-if="status !== 'revoked'"
    class="runners"
    :class="variant"
    aria-labelledby="runners-heading"
    aria-live="polite"
  >
    <h2 id="runners-heading" class="mv-label">
      Runners
      <span v-if="status === 'stale'" class="stale" title="Live updates paused; reconnecting">· not live</span>
    </h2>

    <p v-if="!snapshot" class="loading">Checking…</p>

    <ul v-else class="classes">
      <li v-for="c in classes" :key="c.name" class="cls">
        <StatusDot :status="DOT[availabilityOf(c)]" />
        <span class="label">{{ c.label }}</span>
        <span class="sentence" :class="availabilityOf(c)">{{ classSentence(c) }}</span>
      </li>
    </ul>

    <details v-if="variant === 'rail' && runners && runners.length > 0" class="detail">
      <summary>{{ runners.length }} {{ runners.length === 1 ? 'runner' : 'runners' }}</summary>
      <ul>
        <li
          v-for="r in runners"
          :key="r.id"
          :class="r.state"
          :title="`${r.version} · last heartbeat ${formatDateTime(r.lastHeartbeatAt)}`"
        >
          <span class="id mv-mono">{{ r.id }}</span>
          <span class="mv-num" :aria-label="`${r.busy} of ${r.slots} slots busy`">{{ r.busy }}/{{ r.slots }}</span>
          <span class="state">{{ r.state }}</span>
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.runners { display: flex; flex-direction: column; gap: var(--mv-s-2); }
.stale { color: var(--mv-fg-subtle); text-transform: none; letter-spacing: normal; font-weight: normal; }
.loading { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }

.classes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--mv-s-2); }
.cls { display: grid; grid-template-columns: auto 1fr; column-gap: var(--mv-s-2); align-items: center; }
.label { font-size: var(--mv-fs-sm); }
.sentence { grid-column: 2; font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }
/* The one state that changes what happens to a run launched now. */
.sentence.none { color: var(--mv-danger); }

/* Inline: one strip under a header, classes side by side. */
.inline { flex-direction: row; align-items: baseline; flex-wrap: wrap; gap: var(--mv-s-3); }
.inline .classes { flex-direction: row; flex-wrap: wrap; gap: var(--mv-s-4); }
.inline .cls { display: flex; gap: var(--mv-s-2); align-items: center; }
.inline .sentence { grid-column: auto; }

.detail { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }
.detail summary { cursor: pointer; }
.detail summary:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 2px; border-radius: var(--mv-r-sm); }
.detail ul { list-style: none; margin: var(--mv-s-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--mv-s-1); }
.detail li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: var(--mv-s-2); }
.detail .id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--mv-fg-muted); }
.detail li.offline { opacity: 0.6; }
</style>
