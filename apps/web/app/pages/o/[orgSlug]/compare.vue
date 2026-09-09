<script setup lang="ts">
import type { RunPreview, WireDefinition } from '#shared/definition-wire'
import type { WireValidation, WireValidationDetail } from '#shared/validation-wire'

/**
 * Did it land?
 *
 * Two questions on one screen, because they are two halves of the same answer:
 * the row counts say whether the DATA arrived, and the schema diff says whether
 * the STRUCTURE did. A comparison reporting 100% on every table it knows about
 * is not reassuring if the destination is missing four tables entirely, and
 * only the diff can say so.
 *
 * Reading is `validation:read`, which a viewer has — reading past executions
 * and reports is what the role is for. Running one is `validation:execute`,
 * which it does not: it opens two production databases with stored credentials.
 */

const route = useRoute()
const orgSlug = route.params.orgSlug as string

const { data: me } = await useFetch('/api/me')
const org = computed(() => me.value?.orgs.find((o) => o.slug === orgSlug))
const mayCompare = computed(() => org.value?.permissions.includes('validation:execute') ?? false)
const mayPreview = computed(() => org.value?.permissions.includes('run:execute') ?? false)

const { data: definitionData } = await useFetch<{ definitions: WireDefinition[] }>(
  `/api/orgs/${orgSlug}/definitions`
)
const { data: connectionData } = await useFetch<{
  connections: { id: string; name: string; engine: string; database: string }[]
}>(`/api/orgs/${orgSlug}/connections`, { default: () => ({ connections: [] }) })

const definitions = computed(() => definitionData.value?.definitions ?? [])
const connections = computed(() => connectionData.value?.connections ?? [])

const definitionId = ref((route.query.definition as string) ?? '')
const sourceId = ref('')
const targetId = ref('')
const selectable = ref<{ ok: boolean; reason?: string }>({ ok: false })

const chosen = computed(() => definitions.value.find((d) => d.id === definitionId.value))

watchEffect(() => {
  const definition = chosen.value
  if (!definition) return
  sourceId.value = definition.source.connectionId
  targetId.value = definition.target.connectionId
})

function requestBody() {
  return definitionId.value
    ? { definitionId: definitionId.value }
    : { sourceConnectionId: sourceId.value, targetConnectionId: targetId.value }
}

/**
 * The same gate the run screen uses.
 *
 * A comparison opens both connections through the adapter registry, so an
 * engine Movy has not implemented fails there exactly as a run would — better
 * refused here, with the reason `PairSelector` already put on screen.
 */
const ready = computed(() => selectable.value.ok && Boolean(sourceId.value && targetId.value))

// ---- history ----

const { data: historyData, refresh: refreshHistory } = await useFetch<{
  validations: WireValidation[]
  nextCursor: string | null
}>(`/api/orgs/${orgSlug}/validations`)

const history = computed(() => historyData.value?.validations ?? [])

// ---- the comparison itself ----

/**
 * `?v=<id>` opens a stored comparison.
 *
 * The URL carries it so a result can be sent to someone — which is most of why
 * a comparison is stored at all rather than rendered and forgotten.
 */
const openId = computed(() => (route.query.v as string) || '')

const result = ref<WireValidationDetail | null>(null)

/**
 * An explicit watcher rather than a conditional `useFetch`.
 *
 * `useFetch(url, { immediate: false, watch: [openId] })` looked equivalent and
 * silently never fired when `?v=` was added by navigation — no error, just an
 * empty pane where a result should be. A watcher that calls `$fetch` states
 * plainly when it runs. `useRequestFetch` so it works during SSR too, where a
 * bare `$fetch` would not forward the session cookie and would 401.
 */
const requestFetch = useRequestFetch()

async function openStored(id: string) {
  if (!id) { result.value = null; return }
  if (result.value?.id === id) return
  try {
    const { validation } = await requestFetch<{ validation: WireValidationDetail }>(
      `/api/orgs/${orgSlug}/validations/${id}`
    )
    result.value = validation
  } catch {
    // A `?v=` naming something gone or another org's is not an error worth a
    // banner — it is a stale link. The form below still works.
    result.value = null
  }
}

watch(openId, openStored, { immediate: true })

const comparing = ref(false)
const compareError = ref<string | null>(null)

async function compare() {
  compareError.value = null
  comparing.value = true
  try {
    const { validation } = await $fetch<{ validation: WireValidationDetail }>(
      `/api/orgs/${orgSlug}/validations`,
      { method: 'POST', body: requestBody() }
    )
    result.value = validation
    await refreshHistory()
    // Into the URL, so the result someone is looking at is the result they can
    // send. Replaced rather than pushed: the empty form is not a place to go
    // back to.
    await navigateTo({ query: { ...route.query, v: validation.id } }, { replace: true })
  } catch (err) {
    compareError.value =
      (err as { statusMessage?: string }).statusMessage ?? 'Could not compare those databases.'
  } finally {
    comparing.value = false
  }
}

// ---- schema drift ----

/**
 * Drift is `POST /runs/preview` read the other way round.
 *
 * A preview answers "what would a run change?", and after a migration that is
 * exactly "what did the migration not apply?". One endpoint, so the two screens
 * cannot develop two ideas of what a difference is — and it is `run:execute`
 * rather than `validation:read`, because it opens two production databases.
 */
const drift = ref<RunPreview | null>(null)
const drifting = ref(false)
const driftError = ref<string | null>(null)

async function checkDrift() {
  driftError.value = null
  drifting.value = true
  try {
    const { preview } = await $fetch<{ preview: RunPreview }>(`/api/orgs/${orgSlug}/runs/preview`, {
      method: 'POST',
      body: requestBody(),
    })
    drift.value = preview
  } catch (err) {
    driftError.value =
      (err as { statusMessage?: string }).statusMessage ?? 'Could not inspect those schemas.'
  } finally {
    drifting.value = false
  }
}

// Any change of selection throws both answers away: a result describing a
// different pair of databases is worse than none, because it would be believed.
watch(() => JSON.stringify(requestBody()), () => {
  drift.value = null
  driftError.value = null
  compareError.value = null
})

const num = new Intl.NumberFormat()
const when = (iso: string) => new Date(iso).toLocaleString('en-CA', { hour12: false })
const pct = (value: number) => (value === 100 ? '100' : value.toFixed(2))
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>Compare</h1>
        <p class="sub">Count both sides, and see what the schemas still disagree about.</p>
      </div>
      <NuxtLink :to="`/o/${orgSlug}/runs`" class="back">← All runs</NuxtLink>
    </header>

    <section v-if="mayCompare" class="choose" aria-labelledby="choose-heading">
      <h2 id="choose-heading" class="mv-label">What to compare</h2>

      <label v-if="definitions.length" class="field">
        <span class="mv-label">Saved migration</span>
        <select v-model="definitionId">
          <option value="">One-off — choose connections below</option>
          <option v-for="d in definitions" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
      </label>

      <fieldset class="wrap" :disabled="Boolean(chosen)">
        <PairSelector
          v-model:source-id="sourceId"
          v-model:target-id="targetId"
          :connections="connections"
          :offer-mode="false"
          intent="launch"
          @availability="selectable = $event"
        />
      </fieldset>

      <div class="bar">
        <AppButton variant="primary" :disabled="!ready || comparing" @click="compare">
          {{ comparing ? 'Counting…' : 'Compare row counts' }}
        </AppButton>
        <AppButton v-if="mayPreview" :disabled="!ready || drifting" @click="checkDrift">
          {{ drifting ? 'Inspecting…' : 'Check schema drift' }}
        </AppButton>
      </div>

      <p v-if="compareError" class="err">{{ compareError }}</p>
      <p v-if="driftError" class="err">{{ driftError }}</p>
    </section>

    <p v-else class="empty">
      You can read past comparisons here, but starting one needs the editor role.
    </p>

    <section v-if="result" class="result" aria-labelledby="result-heading">
      <header class="resultHead">
        <h2 id="result-heading" class="mv-label">Result</h2>
        <span class="taken mv-num">{{ when(result.createdAt) }}</span>
      </header>

      <!-- The one hero-size element on this screen. -->
      <div class="headline" :class="{ off: !result.allMatch }">
        <span class="figure mv-num">{{ pct(result.totalMatchPct) }}<span class="sign">%</span></span>
        <span class="unit">
          {{ num.format(result.totalDest) }} of {{ num.format(result.totalSource) }} rows,
          across {{ result.tablesCompared }} tables.
          <template v-if="result.tablesMismatched">
            <strong>{{ result.tablesMismatched }} {{ result.tablesMismatched === 1 ? 'does' : 'do' }} not match.</strong>
          </template>
          <template v-else>Every table matched.</template>
        </span>
      </div>

      <p v-if="result.error" class="err">{{ result.error.message }}</p>

      <CountComparisonTable :tables="result.tables" :all-match="result.allMatch" />
    </section>

    <section v-if="drift" class="result" aria-labelledby="drift-heading">
      <h2 id="drift-heading" class="mv-label">Schema drift</h2>
      <SchemaDiffView
        :diff="drift.diff"
        :type-changes="drift.typeChanges"
        :extra-tables="drift.tables.filter((t) => t.disposition === 'extra').map((t) => t.tableName)"
        :caption="`What a run would still change in ${drift.target.database}, relative to ${drift.source.database}.`"
      />
    </section>

    <section class="history" aria-labelledby="history-heading">
      <h2 id="history-heading" class="mv-label">Past comparisons</h2>

      <p v-if="history.length === 0" class="empty">No comparisons yet.</p>

      <ul v-else class="rows">
        <li v-for="v in history" :key="v.id">
          <NuxtLink :to="{ query: { ...route.query, v: v.id } }" class="row" :class="{ on: v.id === openId }">
            <StatusDot :status="v.status === 'failed' ? 'failed' : v.allMatch ? 'ok' : 'idle'" />
            <span class="name">{{ v.definitionName ?? 'One-off comparison' }}</span>
            <span class="dbs mv-mono">{{ v.source.database }} → {{ v.target.database }}</span>
            <span class="spacer" />
            <span class="figure-sm mv-num" :class="{ off: !v.allMatch }">
              <template v-if="v.status === 'failed'">failed</template>
              <template v-else>{{ pct(v.totalMatchPct) }}%</template>
            </span>
            <span class="when mv-num">{{ when(v.createdAt) }}</span>
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
.back { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); text-decoration: none; white-space: nowrap; }
.back:hover { color: var(--mv-fg); }

.choose, .result {
  display: flex; flex-direction: column; gap: var(--mv-s-4);
  padding: var(--mv-s-4);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg);
  background: var(--mv-bg-base); box-shadow: var(--mv-elev-1);
}
.wrap { border: 0; margin: 0; padding: 0; min-width: 0; }
.wrap:disabled { opacity: 0.62; }

.field { display: flex; flex-direction: column; gap: var(--mv-s-2); }
.field select {
  padding: 6px var(--mv-s-3);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-raised); color: var(--mv-fg); font: inherit; font-size: var(--mv-fs-sm);
}
.field select:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 1px; }

.bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--mv-s-3); }

.resultHead { display: flex; align-items: baseline; justify-content: space-between; gap: var(--mv-s-3); }
.taken { font-size: var(--mv-fs-micro); color: var(--mv-fg-subtle); }

/* Exactly one hero-size element per screen. On a comparison, this is it. */
.headline { display: flex; align-items: baseline; gap: var(--mv-s-3); flex-wrap: wrap; }
.figure {
  font-size: var(--mv-fs-hero); font-weight: var(--mv-fw-semibold);
  line-height: var(--mv-lh-tight); letter-spacing: -0.03em;
  font-variant-numeric: var(--mv-numeric); color: var(--mv-ok);
}
.headline.off .figure { color: var(--mv-warn); }
.sign { font-size: 0.45em; margin-left: 0.1em; }
.unit { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); max-width: 46ch; line-height: var(--mv-lh-body); }
.unit strong { color: var(--mv-warn); font-weight: var(--mv-fw-medium); }

.err { font-size: var(--mv-fs-xs); color: var(--mv-danger); }
.empty {
  padding: var(--mv-s-5); border: 1px dashed var(--mv-line); border-radius: var(--mv-r-md);
  font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle);
}

.history { display: flex; flex-direction: column; gap: var(--mv-s-3); }
.rows { list-style: none; margin: 0; padding: 0; border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg); overflow: hidden; }
.rows li + li { border-top: 1px solid var(--mv-line); }
.row {
  display: flex; align-items: center; gap: var(--mv-s-3);
  padding: var(--mv-s-3) var(--mv-s-4);
  background: var(--mv-bg-base); color: inherit; text-decoration: none;
  transition: background var(--mv-dur-1) var(--mv-ease-out);
}
.row:hover, .row.on { background: var(--mv-bg-raised); text-decoration: none; }
.row.on { box-shadow: inset 2px 0 0 var(--mv-accent); }
.name { font-size: var(--mv-fs-sm); font-weight: var(--mv-fw-medium); }
.dbs { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }
.spacer { flex: 1; }
.figure-sm { font-size: var(--mv-fs-sm); color: var(--mv-ok); }
.figure-sm.off { color: var(--mv-warn); }
.when { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); white-space: nowrap; }

@media (max-width: 720px) {
  .dbs, .when { display: none; }
  .head { flex-direction: column; }
}
</style>
