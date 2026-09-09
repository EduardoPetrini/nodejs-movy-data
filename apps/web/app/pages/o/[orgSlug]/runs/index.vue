<script setup lang="ts">
import { isTerminal, type WireRun } from '#shared/run-wire'

interface RunPage {
  runs: WireRun[]
  nextCursor: string | null
  /** First page only, keyed by definition id: the last ten durations, oldest first. */
  sparklines?: Record<string, number[]>
}

const route = useRoute()
const orgSlug = route.params.orgSlug as string

const { data: me } = await useFetch('/api/me')
const org = computed(() => me.value?.orgs.find((o) => o.slug === orgSlug))
const mayRun = computed(() => org.value?.permissions.includes('run:execute') ?? false)
const mayCompare = computed(() => org.value?.permissions.includes('validation:read') ?? false)

/**
 * The status filter lives in the URL, not in a ref.
 *
 * A filtered ledger is the thing people paste into a chat when something has
 * gone wrong, and a filter held only in memory makes that link show the
 * unfiltered list to whoever opens it.
 */
const status = computed(() => (route.query.status as string) || '')

const { data, refresh } = await useFetch<RunPage>(`/api/orgs/${orgSlug}/runs`, {
  query: { status: computed(() => status.value || undefined) },
})

/**
 * Pages already loaded, appended.
 *
 * Kept beside the first page rather than merged into it, so a refresh — which
 * only ever re-reads page one — cannot silently discard what was loaded below
 * it, nor duplicate it. The cursor is keyset, so pages never overlap.
 */
const more = ref<WireRun[]>([])
const cursor = ref<string | null>(null)
const loadingMore = ref(false)

watch(data, (page) => { more.value = []; cursor.value = page?.nextCursor ?? null }, { immediate: true })

const rows = computed(() => [...(data.value?.runs ?? []), ...more.value])
const sparklines = computed(() => data.value?.sparklines ?? {})

async function loadMore() {
  if (!cursor.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const next = await $fetch<RunPage>(`/api/orgs/${orgSlug}/runs`, {
      query: { cursor: cursor.value, status: status.value || undefined },
    })
    more.value = [...more.value, ...next.runs]
    cursor.value = next.nextCursor
  } finally {
    loadingMore.value = false
  }
}

function setStatus(value: string) {
  navigateTo({ query: value ? { status: value } : {} })
}

/**
 * `en-CA` rather than the browser's locale.
 *
 * `toLocaleString()` resolves against Node's locale on the server and the
 * browser's on the client — `2026-09-07` against `9/7/2026` — which Vue reports
 * as a hydration mismatch on every row. Pinned, as `members.vue` already is.
 */
const when = (iso: string) => new Date(iso).toLocaleString('en-CA', { hour12: false })
const num = new Intl.NumberFormat()

function dot(runStatus: string) {
  if (runStatus === 'succeeded') return 'ok'
  if (runStatus === 'failed') return 'failed'
  return isTerminal(runStatus) ? 'idle' : 'running'
}

function duration(run: WireRun): string {
  if (run.durationMs === null) return '—'
  if (run.durationMs < 1000) return `${run.durationMs}ms`
  if (run.durationMs < 60_000) return `${(run.durationMs / 1000).toFixed(1)}s`
  return `${Math.round(run.durationMs / 60_000)}m`
}

const STATUS_FILTERS = ['', 'running', 'succeeded', 'failed', 'cancelled'] as const
const FILTER_LABELS: Record<string, string> = {
  '': 'All', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled',
}

// Poll while anything is in flight: this page has no socket of its own, and a
// list that silently goes stale is worse than one that costs a request. Only
// page one is refreshed — the pages below it are history and cannot change.
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => {
    if (rows.value.some((r) => !isTerminal(r.status))) void refresh()
  }, 3000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>Runs</h1>
        <p class="sub">Every migration this organisation has executed.</p>
      </div>
      <div class="actions">
        <NuxtLink v-if="mayCompare" :to="`/o/${orgSlug}/compare`" class="ghost">Compare</NuxtLink>
        <!-- Starting a run goes through the review screen. A migration that
             empties its destination and cannot be rolled back should not begin
             with one click from a list. -->
        <NuxtLink v-if="mayRun" :to="`/o/${orgSlug}/runs/new`" class="cta">New run</NuxtLink>
      </div>
    </header>

    <nav class="filters" aria-label="Filter by status">
      <button
        v-for="f in STATUS_FILTERS"
        :key="f || 'all'"
        type="button"
        class="chip"
        :class="{ on: status === f }"
        :aria-pressed="status === f"
        @click="setStatus(f)"
      >
        {{ FILTER_LABELS[f] }}
      </button>
    </nav>

    <section class="list" aria-labelledby="history-heading">
      <h2 id="history-heading" class="mv-label">History</h2>

      <p v-if="rows.length === 0" class="empty">
        <template v-if="status">No {{ status }} runs.</template>
        <template v-else>
          No runs yet.<template v-if="mayRun"> Start one with <em>New run</em>.</template>
        </template>
      </p>

      <ul v-else class="runs">
        <li v-for="run in rows" :key="run.id">
          <NuxtLink :to="`/o/${orgSlug}/runs/${run.id}`" class="row">
            <StatusDot :status="dot(run.status)" />
            <span class="status">{{ run.status }}</span>
            <span class="name">{{ run.definitionName ?? 'Ad-hoc run' }}</span>
            <PairChip :source="run.source.engine" :target="run.target.engine" />
            <span class="dbs mv-mono">{{ run.source.database }} → {{ run.target.database }}</span>
            <span v-if="run.simulated" class="tag">sim</span>
            <span class="spacer" />
            <DurationSparkline
              v-if="run.definitionId"
              class="spark"
              :values="sparklines[run.definitionId] ?? []"
              :label="run.definitionName ?? 'This migration'"
            />
            <span class="rows mv-num">{{ num.format(run.progress.rowsDone) }} rows</span>
            <span class="dur mv-num">{{ duration(run) }}</span>
            <span class="when mv-num">{{ when(run.createdAt) }}</span>
          </NuxtLink>
        </li>
      </ul>

      <div v-if="cursor" class="pager">
        <AppButton :disabled="loadingMore" @click="loadMore">
          {{ loadingMore ? 'Loading…' : 'Load older runs' }}
        </AppButton>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: var(--mv-s-5); max-width: 1100px; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--mv-s-4); }
.head h1 { font-size: var(--mv-fs-lg); letter-spacing: -0.015em; }
.sub { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); margin-top: var(--mv-s-1); }
.actions { display: flex; align-items: center; gap: var(--mv-s-2); }

.cta {
  padding: 6px var(--mv-s-3);
  border: 1px solid transparent; border-radius: var(--mv-r-md);
  background: var(--mv-accent); color: var(--mv-accent-fg);
  font-size: var(--mv-fs-sm); font-weight: var(--mv-fw-medium); text-decoration: none;
  box-shadow: var(--mv-elev-1); white-space: nowrap;
  transition: opacity var(--mv-dur-1) var(--mv-ease-out);
}
.cta:hover { opacity: 0.9; text-decoration: none; }
.cta:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 2px; }

.ghost {
  padding: 6px var(--mv-s-3);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-base); color: var(--mv-fg-muted);
  font-size: var(--mv-fs-sm); text-decoration: none; white-space: nowrap;
  transition: color var(--mv-dur-1) var(--mv-ease-out), border-color var(--mv-dur-1) var(--mv-ease-out);
}
.ghost:hover { color: var(--mv-fg); border-color: var(--mv-line-strong); text-decoration: none; }
.ghost:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 2px; }

.filters { display: flex; flex-wrap: wrap; gap: var(--mv-s-2); }
.chip {
  padding: 3px var(--mv-s-3);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-pill);
  background: transparent; color: var(--mv-fg-subtle);
  font: inherit; font-size: var(--mv-fs-xs); cursor: pointer;
  transition: color var(--mv-dur-1) var(--mv-ease-out), border-color var(--mv-dur-1) var(--mv-ease-out);
}
.chip:hover { color: var(--mv-fg); border-color: var(--mv-line-strong); }
.chip.on { color: var(--mv-fg); border-color: var(--mv-accent); }
.chip:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 2px; }

.empty em { font-style: normal; color: var(--mv-fg-muted); }

.list { display: flex; flex-direction: column; gap: var(--mv-s-3); }
.empty {
  padding: var(--mv-s-5); border: 1px dashed var(--mv-line); border-radius: var(--mv-r-md);
  font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle);
}
.runs { list-style: none; margin: 0; padding: 0; border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg); overflow: hidden; }
.runs li + li { border-top: 1px solid var(--mv-line); }

/**
 * A fixed height, not padding.
 *
 * With padding alone, a row whose database pair wrapped grew taller than the
 * rest and broke the ledger's rhythm — the same class of bug as the timeline
 * colliding with itself on a wrapped label. Every cell that can be long
 * truncates instead.
 */
.row {
  display: flex; align-items: center; gap: var(--mv-s-3);
  height: 40px; padding: 0 var(--mv-s-4);
  background: var(--mv-bg-base); color: inherit; text-decoration: none;
  transition: background var(--mv-dur-1) var(--mv-ease-out);
}
.row:hover { background: var(--mv-bg-raised); text-decoration: none; }
.status { font-size: var(--mv-fs-sm); text-transform: capitalize; min-width: 72px; flex: none; }
.name {
  flex: none; font-size: var(--mv-fs-sm); font-weight: var(--mv-fw-medium);
  width: 18ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dbs {
  font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.tag {
  flex: none;
  font-size: var(--mv-fs-micro); text-transform: uppercase; letter-spacing: var(--mv-track-label);
  padding: 1px 5px; border-radius: var(--mv-r-sm); background: var(--mv-warn-dim); color: var(--mv-warn);
}
.spacer { flex: 1; }
.rows, .when, .dur { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); white-space: nowrap; }
.dur { min-width: 5ch; text-align: right; }

.pager { display: flex; justify-content: center; }

@media (max-width: 900px) {
  .dbs, .spark { display: none; }
}
@media (max-width: 720px) {
  .rows, .dur { display: none; }
  .head { flex-direction: column; }
}
</style>
