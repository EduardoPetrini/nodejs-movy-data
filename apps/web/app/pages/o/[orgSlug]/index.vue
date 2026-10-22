<script setup lang="ts">
import { isTerminal, type WireRun } from '#shared/run-wire'
import { formatDateTime } from '../../../utils/format-datetime'

interface StatsSummary {
  windowDays: number
  runsByStatus: { status: string; count: number }[]
  totalRuns: number
  activeRuns: number
  durationP50Ms: number | null
  durationP95Ms: number | null
  rowsCopied: number
  liveDefinitions: number
  validations: number
  validationsAllMatch: number
  lastRunAt: string | null
}

/**
 * The organisation's home.
 *
 * Sign-in lands here rather than on Connections, which is configuration. What
 * someone opening Movy wants to know is whether anything is running, whether
 * the last thing that ran worked, and how long it took — not which credentials
 * are saved.
 *
 * No card grid: a 240px summary rail beside the ledger. Density is the
 * aesthetic, and the ledger is the page — the numbers are context for it.
 */

const route = useRoute()
const orgSlug = route.params.orgSlug as string

const { data: me } = await useFetch('/api/me')
const org = computed(() => me.value?.orgs.find((o) => o.slug === orgSlug))
const mayRun = computed(() => org.value?.permissions.includes('run:execute') ?? false)
const mayCompare = computed(() => org.value?.permissions.includes('validation:read') ?? false)

const { data: statsData, refresh: refreshStats } = await useFetch<{ summary: StatsSummary }>(
  `/api/orgs/${orgSlug}/stats/summary`
)
const { data: runData, refresh: refreshRuns } = await useFetch<{
  runs: WireRun[]
  sparklines?: Record<string, number[]>
}>(`/api/orgs/${orgSlug}/runs`, { query: { limit: 12 } })

const summary = computed(() => statsData.value?.summary)
const runs = computed(() => runData.value?.runs ?? [])
const sparklines = computed(() => runData.value?.sparklines ?? {})

const num = new Intl.NumberFormat()
const when = formatDateTime

/**
 * Null is rendered as an em dash, never as zero.
 *
 * A p95 over no settled runs is not 0ms, and a dashboard that says it is tells
 * a new organisation that its migrations are instant.
 */
function ms(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value < 1000) return `${value}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`
  return `${Math.round(value / 60_000)}m`
}

function dot(status: string) {
  if (status === 'succeeded') return 'ok'
  if (status === 'failed') return 'failed'
  return isTerminal(status) ? 'idle' : 'running'
}

const failed = computed(
  () => summary.value?.runsByStatus.find((s) => s.status === 'failed')?.count ?? 0
)

// While anything is in flight, both halves go stale together — so they refresh
// together, or the counts and the list would disagree on screen.
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => {
    if (runs.value.some((r) => !isTerminal(r.status))) {
      void Promise.all([refreshRuns(), refreshStats()])
    }
  }, 3000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>{{ org?.name ?? orgSlug }}</h1>
        <p class="sub">
          <template v-if="summary?.lastRunAt">
            Last run {{ when(summary.lastRunAt) }}.
          </template>
          <template v-else>Nothing has run here yet.</template>
          <template v-if="summary?.activeRuns">
            <strong>{{ summary.activeRuns }} in flight.</strong>
          </template>
        </p>
      </div>
      <div class="actions">
        <NuxtLink v-if="mayCompare" :to="`/o/${orgSlug}/compare`" class="ghost">Compare</NuxtLink>
        <NuxtLink v-if="mayRun" :to="`/o/${orgSlug}/runs/new`" class="cta">New run</NuxtLink>
      </div>
    </header>

    <div class="body">
      <aside class="stats" aria-labelledby="stats-heading">
        <h2 id="stats-heading" class="mv-label">
          Last {{ summary?.windowDays ?? 30 }} days
        </h2>

        <dl class="figures">
          <div>
            <dt>Runs</dt>
            <dd class="mv-num big">{{ num.format(summary?.totalRuns ?? 0) }}</dd>
          </div>
          <div :class="{ bad: failed > 0 }">
            <dt>Failed</dt>
            <dd class="mv-num big">{{ num.format(failed) }}</dd>
          </div>
          <div>
            <dt>Median duration</dt>
            <dd class="mv-num">{{ ms(summary?.durationP50Ms) }}</dd>
          </div>
          <div>
            <dt>p95 duration</dt>
            <dd class="mv-num">{{ ms(summary?.durationP95Ms) }}</dd>
          </div>
          <div>
            <dt>Rows copied</dt>
            <dd class="mv-num">{{ num.format(summary?.rowsCopied ?? 0) }}</dd>
          </div>
          <div>
            <dt>Saved migrations</dt>
            <dd class="mv-num">{{ num.format(summary?.liveDefinitions ?? 0) }}</dd>
          </div>
          <div v-if="summary?.validations">
            <dt>Comparisons</dt>
            <dd class="mv-num">
              {{ summary.validationsAllMatch }}<span class="of">/{{ summary.validations }} clean</span>
            </dd>
          </div>
        </dl>
      </aside>

      <section class="ledger" aria-labelledby="ledger-heading">
        <header class="ledgerHead">
          <h2 id="ledger-heading" class="mv-label">Recent runs</h2>
          <NuxtLink :to="`/o/${orgSlug}/runs`" class="all">All runs →</NuxtLink>
        </header>

        <p v-if="runs.length === 0" class="empty">
          No runs yet.<template v-if="mayRun"> Start one with <em>New run</em>.</template>
        </p>

        <ul v-else class="rows">
          <li v-for="run in runs" :key="run.id">
            <NuxtLink :to="`/o/${orgSlug}/runs/${run.id}`" class="row">
              <StatusDot :status="dot(run.status)" />
              <span class="name">{{ run.definitionName ?? 'Ad-hoc run' }}</span>
              <span class="dbs mv-mono">{{ run.source.database }} → {{ run.target.database }}</span>
              <span class="spacer" />
              <DurationSparkline
                v-if="run.definitionId"
                :values="sparklines[run.definitionId] ?? []"
                :label="run.definitionName ?? 'This migration'"
              />
              <span class="rows-n mv-num">{{ num.format(run.progress.rowsDone) }}</span>
              <span class="when mv-num">{{ when(run.createdAt) }}</span>
            </NuxtLink>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: var(--mv-s-5); max-width: 1180px; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--mv-s-4); }
.head h1 { font-size: var(--mv-fs-lg); letter-spacing: -0.015em; }
.sub { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); margin-top: var(--mv-s-1); }
.sub strong { color: var(--mv-accent); font-weight: var(--mv-fw-medium); }
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
}
.ghost:hover { color: var(--mv-fg); border-color: var(--mv-line-strong); text-decoration: none; }
.ghost:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 2px; }

/* A rail beside the ledger, not a grid of cards. */
.body { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: var(--mv-s-5); align-items: start; }

.stats {
  display: flex; flex-direction: column; gap: var(--mv-s-4);
  padding: var(--mv-s-4);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg);
  background: var(--mv-bg-base);
}
.figures { display: flex; flex-direction: column; gap: var(--mv-s-3); margin: 0; }
.figures div { display: flex; flex-direction: column; gap: 1px; }
.figures dt {
  font-size: var(--mv-fs-micro); text-transform: uppercase;
  letter-spacing: var(--mv-track-label); color: var(--mv-fg-subtle);
}
.figures dd { margin: 0; font-size: var(--mv-fs-sm); font-variant-numeric: var(--mv-numeric); }
.figures dd.big { font-size: var(--mv-fs-md); font-weight: var(--mv-fw-medium); }
.figures .bad dd { color: var(--mv-danger); }
.of { color: var(--mv-fg-subtle); }

.ledger { display: flex; flex-direction: column; gap: var(--mv-s-3); min-width: 0; }
.ledgerHead { display: flex; align-items: baseline; justify-content: space-between; gap: var(--mv-s-3); }
.all { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); text-decoration: none; }
.all:hover { color: var(--mv-accent); }

.empty {
  padding: var(--mv-s-5); border: 1px dashed var(--mv-line); border-radius: var(--mv-r-md);
  font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle);
}
.empty em { font-style: normal; color: var(--mv-fg-muted); }

.rows { list-style: none; margin: 0; padding: 0; border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg); overflow: hidden; }
.rows li + li { border-top: 1px solid var(--mv-line); }
.row {
  display: flex; align-items: center; gap: var(--mv-s-3);
  height: var(--mv-row-h); padding: 0 var(--mv-s-4);
  background: var(--mv-bg-base); color: inherit; text-decoration: none;
  transition: background var(--mv-dur-1) var(--mv-ease-out);
}
.row:hover { background: var(--mv-bg-raised); text-decoration: none; }
.name {
  font-size: var(--mv-fs-sm);
  max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dbs { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }
.spacer { flex: 1; }
.rows-n, .when { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); white-space: nowrap; }

@media (max-width: 900px) {
  .body { grid-template-columns: minmax(0, 1fr); }
  .figures { flex-direction: row; flex-wrap: wrap; gap: var(--mv-s-5); }
  .dbs { display: none; }
}
@media (max-width: 720px) {
  .head { flex-direction: column; }
  .rows-n { display: none; }
}
</style>
