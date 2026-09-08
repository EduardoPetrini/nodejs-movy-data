<script setup lang="ts">
import { isTerminal, type WireRun } from '#shared/run-wire'

const route = useRoute()
const orgSlug = route.params.orgSlug as string

const { data: me } = await useFetch('/api/me')
const org = computed(() => me.value?.orgs.find((o) => o.slug === orgSlug))
const mayRun = computed(() => org.value?.permissions.includes('run:execute') ?? false)

const { data, refresh } = await useFetch<{ runs: WireRun[] }>(`/api/orgs/${orgSlug}/runs`)

const when = (iso: string) => new Date(iso).toLocaleString()
const rows = new Intl.NumberFormat()

function dot(status: string) {
  if (status === 'succeeded') return 'ok'
  if (status === 'failed') return 'failed'
  return isTerminal(status) ? 'idle' : 'running'
}

// Poll while anything is in flight: this page has no socket of its own, and a
// list that silently goes stale is worse than one that costs a request.
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => {
    if (data.value?.runs.some((r) => !isTerminal(r.status))) void refresh()
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
      <!-- Starting a run now goes through the review screen. A migration that
           empties its destination and cannot be rolled back should not begin
           with one click from a list. -->
      <NuxtLink v-if="mayRun" :to="`/o/${orgSlug}/runs/new`" class="cta">New run</NuxtLink>
    </header>

    <section class="list" aria-labelledby="history-heading">
      <h2 id="history-heading" class="mv-label">History</h2>

      <p v-if="(data?.runs.length ?? 0) === 0" class="empty">
        No runs yet.<template v-if="mayRun"> Start one with <em>New run</em>.</template>
      </p>

      <ul v-else class="runs">
        <li v-for="run in data?.runs ?? []" :key="run.id">
          <NuxtLink :to="`/o/${orgSlug}/runs/${run.id}`" class="row">
            <StatusDot :status="dot(run.status)" />
            <span class="status">{{ run.status }}</span>
            <PairChip :source="run.source.engine" :target="run.target.engine" />
            <span class="dbs mv-mono">{{ run.source.database }} → {{ run.target.database }}</span>
            <span v-if="run.simulated" class="tag">sim</span>
            <span class="spacer" />
            <span class="rows mv-num">{{ rows.format(run.progress.rowsDone) }} rows</span>
            <span class="when mv-num">{{ when(run.createdAt) }}</span>
          </NuxtLink>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: var(--mv-s-6); max-width: 1100px; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--mv-s-4); }
.head h1 { font-size: var(--mv-fs-lg); letter-spacing: -0.015em; }
.sub { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); margin-top: var(--mv-s-1); }

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

.empty em { font-style: normal; color: var(--mv-fg-muted); }

.list { display: flex; flex-direction: column; gap: var(--mv-s-3); }
.empty {
  padding: var(--mv-s-5); border: 1px dashed var(--mv-line); border-radius: var(--mv-r-md);
  font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle);
}
.runs { list-style: none; margin: 0; padding: 0; border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg); overflow: hidden; }
.runs li + li { border-top: 1px solid var(--mv-line); }

.row {
  display: flex; align-items: center; gap: var(--mv-s-3);
  padding: var(--mv-s-3) var(--mv-s-4);
  background: var(--mv-bg-base); color: inherit; text-decoration: none;
  transition: background var(--mv-dur-1) var(--mv-ease-out);
}
.row:hover { background: var(--mv-bg-raised); text-decoration: none; }
.status { font-size: var(--mv-fs-sm); text-transform: capitalize; min-width: 72px; }
.dbs { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }
.tag {
  font-size: var(--mv-fs-micro); text-transform: uppercase; letter-spacing: var(--mv-track-label);
  padding: 1px 5px; border-radius: var(--mv-r-sm); background: var(--mv-warn-dim); color: var(--mv-warn);
}
.spacer { flex: 1; }
.rows, .when { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); white-space: nowrap; }

@media (max-width: 720px) {
  .dbs, .rows { display: none; }
  .head { flex-direction: column; }
}
</style>
