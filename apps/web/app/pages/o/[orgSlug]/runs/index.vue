<script setup lang="ts">
import { isTerminal, type WireRun } from '#shared/run-wire'

const route = useRoute()
const orgSlug = route.params.orgSlug as string

const { data: me } = await useFetch('/api/me')
const org = computed(() => me.value?.orgs.find((o) => o.slug === orgSlug))
const mayRun = computed(() => org.value?.permissions.includes('run:execute') ?? false)

const { data, refresh } = await useFetch<{ runs: WireRun[] }>(`/api/orgs/${orgSlug}/runs`)
const { data: connections } = await useFetch<{ connections: { id: string; name: string; engine: string; database: string }[] }>(
  `/api/orgs/${orgSlug}/connections`
)

const sourceId = ref('')
const targetId = ref('')
const simulate = ref(true)
const launching = ref(false)
const launchError = ref<string | null>(null)

async function launch() {
  launchError.value = null
  launching.value = true
  try {
    const { run } = await $fetch<{ run: WireRun }>(`/api/orgs/${orgSlug}/runs`, {
      method: 'POST',
      body: {
        sourceConnectionId: sourceId.value,
        targetConnectionId: targetId.value,
        // A filesystem path is the server's business, not the browser's: the
        // client asks for simulation and the server decides what to replay.
        ...(simulate.value ? { simulate: true, speed: 0.02 } : {}),
      },
    })
    await navigateTo(`/o/${orgSlug}/runs/${run.id}`)
  } catch (err) {
    launchError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not start the run.'
    launching.value = false
  }
}

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
      <h1>Runs</h1>
      <p class="sub">Every migration this organisation has executed.</p>
    </header>

    <section v-if="mayRun" class="launch" aria-labelledby="launch-heading">
      <h2 id="launch-heading" class="mv-label">Start a run</h2>
      <div class="form">
        <label class="field">
          <span class="mv-label">Source</span>
          <select v-model="sourceId">
            <option value="" disabled>Choose a connection</option>
            <option v-for="c in connections?.connections ?? []" :key="c.id" :value="c.id">
              {{ c.name }} — {{ c.database }}
            </option>
          </select>
        </label>

        <span class="arrow" aria-hidden="true">→</span>

        <label class="field">
          <span class="mv-label">Destination</span>
          <select v-model="targetId">
            <option value="" disabled>Choose a connection</option>
            <option v-for="c in connections?.connections ?? []" :key="c.id" :value="c.id">
              {{ c.name }} — {{ c.database }}
            </option>
          </select>
        </label>

        <label class="check">
          <input v-model="simulate" type="checkbox">
          <span>Simulate<em>replay a recording; no database is touched</em></span>
        </label>

        <AppButton variant="primary" :disabled="!sourceId || !targetId || launching" @click="launch">
          {{ launching ? 'Starting…' : 'Run' }}
        </AppButton>
      </div>
      <p v-if="launchError" class="err">{{ launchError }}</p>
    </section>

    <section class="list" aria-labelledby="history-heading">
      <h2 id="history-heading" class="mv-label">History</h2>

      <p v-if="(data?.runs.length ?? 0) === 0" class="empty">
        No runs yet.<template v-if="mayRun"> Start one above.</template>
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
.head h1 { font-size: var(--mv-fs-lg); letter-spacing: -0.015em; }
.sub { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); margin-top: var(--mv-s-1); }

.launch {
  display: flex; flex-direction: column; gap: var(--mv-s-3);
  padding: var(--mv-s-4);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg);
  background: var(--mv-bg-base); box-shadow: var(--mv-elev-1);
}
.form { display: flex; align-items: flex-end; gap: var(--mv-s-4); flex-wrap: wrap; }
.field { display: flex; flex-direction: column; gap: var(--mv-s-1); min-width: 200px; }
.field select {
  padding: 6px var(--mv-s-3);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-raised); font-size: var(--mv-fs-sm);
}
.arrow { color: var(--mv-fg-subtle); padding-bottom: 8px; }
.check { display: flex; align-items: center; gap: var(--mv-s-2); font-size: var(--mv-fs-xs); color: var(--mv-fg-muted); }
.check em { display: block; font-style: normal; font-size: var(--mv-fs-micro); color: var(--mv-fg-subtle); }

.err { font-size: var(--mv-fs-xs); color: var(--mv-danger); }

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
  .form { flex-direction: column; align-items: stretch; }
  .arrow { display: none; }
}
</style>
