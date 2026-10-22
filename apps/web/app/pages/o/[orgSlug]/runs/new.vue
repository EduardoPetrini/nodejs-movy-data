<script setup lang="ts">
import type { RunPreview, WireDefinition } from '#shared/definition-wire'
import type { RunMode } from '#shared/pair-capability'
import type { WireRun } from '#shared/run-wire'

/**
 * Review, then run.
 *
 * The screen exists because applying is all-or-nothing with no rollback and
 * Movy empties every destination table before loading it. Starting that from a
 * pair of dropdowns and a button is a mistake waiting to happen; reading what
 * it will do first is the whole point.
 *
 * The preview is deliberately not automatic. It opens connections to two real
 * databases, so it happens when someone asks for it — and it is thrown away
 * the moment the selection changes, because a preview of a different migration
 * is worse than none: it would be believed.
 */

const route = useRoute()
const orgSlug = route.params.orgSlug as string

const { data: me } = await useFetch('/api/me')
const org = computed(() => me.value?.orgs.find((o) => o.slug === orgSlug))
const mayRun = computed(() => org.value?.permissions.includes('run:execute') ?? false)

const { data: connectionData } = await useFetch<{
  connections: { id: string; name: string; engine: string; database: string }[]
}>(`/api/orgs/${orgSlug}/connections`)
const { data: definitionData } = await useFetch<{ definitions: WireDefinition[] }>(
  `/api/orgs/${orgSlug}/definitions`
)

const connections = computed(() => connectionData.value?.connections ?? [])
const definitions = computed(() => definitionData.value?.definitions ?? [])

/** '' means a one-off run — legitimate; not everything deserves a name. */
const definitionId = ref((route.query.definition as string) ?? '')
const sourceId = ref('')
const targetId = ref('')
const mode = ref<RunMode>('full')
const sourceDatabase = ref('')
const targetDatabase = ref('')
const simulate = ref(false)
const selectable = ref<{ ok: boolean; reason?: string }>({ ok: false })

const chosen = computed(() => definitions.value.find((d) => d.id === definitionId.value))

/**
 * A chosen definition fills the selector and takes it out of play.
 *
 * The server resolves a definition's own fields and ignores overrides, so
 * leaving the controls live would let someone change a value that has no
 * effect — a form lying about what it is going to do.
 */
watchEffect(() => {
  const definition = chosen.value
  if (!definition) return
  sourceId.value = definition.source.connectionId
  targetId.value = definition.target.connectionId
  mode.value = definition.mode
  sourceDatabase.value = definition.source.pinned ? definition.source.database : ''
  targetDatabase.value = definition.target.pinned ? definition.target.database : ''
})

// ---- preview ----

const preview = ref<RunPreview | null>(null)
const previewing = ref(false)
const previewError = ref<string | null>(null)

function requestBody() {
  return definitionId.value
    ? { definitionId: definitionId.value }
    : {
        sourceConnectionId: sourceId.value,
        targetConnectionId: targetId.value,
        sourceDatabase: sourceDatabase.value || undefined,
        targetDatabase: targetDatabase.value || undefined,
        mode: mode.value,
      }
}

/**
 * Any change to the selection throws the preview away.
 *
 * Watched on the resolved body rather than on each field, so it also catches a
 * definition swapped for another with the same endpoints but a different mode.
 */
watch(
  () => JSON.stringify(requestBody()),
  () => {
    preview.value = null
    previewError.value = null
  }
)

async function runPreview() {
  previewError.value = null
  previewing.value = true
  try {
    const result = await $fetch<{ preview: RunPreview }>(`/api/orgs/${orgSlug}/runs/preview`, {
      method: 'POST',
      body: requestBody(),
    })
    preview.value = result.preview
  } catch (err) {
    previewError.value =
      (err as { statusMessage?: string }).statusMessage ?? 'Could not inspect those databases.'
  } finally {
    previewing.value = false
  }
}

// ---- launch ----

const launching = ref(false)
const launchError = ref<string | null>(null)

async function launch() {
  launchError.value = null
  launching.value = true
  try {
    const { run } = await $fetch<{ run: WireRun }>(`/api/orgs/${orgSlug}/runs`, {
      method: 'POST',
      body: {
        ...requestBody(),
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

const ready = computed(() => selectable.value.ok && Boolean(sourceId.value && targetId.value))
/** Simulation touches no database, so there is nothing to review first. */
const needsPreview = computed(() => !simulate.value && !preview.value)
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>New run</h1>
        <p class="sub">Review what it will do, then start it.</p>
      </div>
      <NuxtLink :to="`/o/${orgSlug}/runs`" class="back">← All runs</NuxtLink>
    </header>

    <p v-if="!mayRun" class="empty">You do not have permission to start runs in this organisation.</p>

    <template v-else>
      <section class="choose" aria-labelledby="choose-heading">
        <h2 id="choose-heading" class="mv-label">What to run</h2>

        <label v-if="definitions.length" class="field">
          <span class="mv-label">Saved migration</span>
          <select v-model="definitionId">
            <option value="">One-off — choose connections below</option>
            <option v-for="d in definitions" :key="d.id" :value="d.id">{{ d.name }}</option>
          </select>
        </label>

        <!-- Disabled rather than hidden when a definition is chosen: seeing
             what it resolves to is the point; editing it here is not. -->
        <fieldset class="wrap" :disabled="Boolean(chosen)">
          <PairSelector
            v-model:source-id="sourceId"
            v-model:target-id="targetId"
            v-model:mode="mode"
            :connections="connections"
            :offer-mode="!chosen"
            intent="launch"
            @availability="selectable = $event"
          />

          <div v-if="!chosen" class="overrides">
            <label class="field">
              <span class="mv-label">Source database <em>optional</em></span>
              <input v-model="sourceDatabase" type="text" placeholder="follow the connection">
            </label>
            <label class="field">
              <span class="mv-label">Destination database <em>optional</em></span>
              <input v-model="targetDatabase" type="text" placeholder="follow the connection">
            </label>
          </div>
        </fieldset>

        <p v-if="chosen" class="note">
          Running the saved migration <strong>{{ chosen.name }}</strong>.
          Edit it on the Migrations page to change any of this.
        </p>
        <p v-else-if="!selectable.ok && selectable.reason" class="hint">{{ selectable.reason }}</p>

        <label class="check">
          <input v-model="simulate" type="checkbox">
          <span>Simulate<em>replay a recording; no database is touched</em></span>
        </label>
      </section>

      <section class="review">
        <div class="reviewBar">
          <AppButton :disabled="!ready || previewing || simulate" @click="runPreview">
            {{ previewing ? 'Inspecting…' : preview ? 'Refresh preview' : 'Preview' }}
          </AppButton>
          <p v-if="simulate" class="muted">
            A simulated run replays a recording, so there is nothing to inspect.
          </p>
          <p v-else-if="needsPreview" class="muted">
            Preview first. Movy empties every destination table before loading it, and there is no
            rollback.
          </p>
        </div>

        <p v-if="previewError" class="err">{{ previewError }}</p>
        <PreviewPanel v-if="preview" :preview="preview" />
      </section>

      <section class="launch">
        <AppButton variant="primary" :disabled="!ready || launching || needsPreview" @click="launch">
          {{ launching ? 'Starting…' : simulate ? 'Start simulated run' : 'Start run' }}
        </AppButton>
        <p v-if="launchError" class="err">{{ launchError }}</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: var(--mv-s-5); max-width: 900px; }

.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--mv-s-4); }
.head h1 { font-size: var(--mv-fs-lg); letter-spacing: -0.015em; }
.sub { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); margin-top: var(--mv-s-1); }
.back { font-size: var(--mv-fs-xs); color: var(--mv-fg-muted); text-decoration: none; }
.back:hover { color: var(--mv-accent); }

.choose {
  display: flex; flex-direction: column; gap: var(--mv-s-3);
  padding: var(--mv-s-4);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg);
  background: var(--mv-bg-base); box-shadow: var(--mv-elev-1);
}
.wrap {
  border: 0; padding: 0; margin: 0; min-width: 0;
  display: flex; flex-direction: column; gap: var(--mv-s-3);
}
.wrap:disabled { opacity: 0.72; }

.field { display: flex; flex-direction: column; gap: var(--mv-s-1); }
.field em { font-style: normal; opacity: 0.65; text-transform: none; letter-spacing: 0; }
.field select, .field input {
  padding: 6px var(--mv-s-3);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-raised); color: var(--mv-fg);
  font-family: inherit; font-size: var(--mv-fs-sm);
}
.field select:focus-visible, .field input:focus-visible {
  outline: 2px solid var(--mv-focus); outline-offset: 1px;
}
.overrides { display: flex; gap: var(--mv-s-4); flex-wrap: wrap; }
.overrides .field { flex: 1; min-width: 220px; }

.check { display: flex; align-items: center; gap: var(--mv-s-2); font-size: var(--mv-fs-xs); color: var(--mv-fg-muted); }
.check em { display: block; font-style: normal; font-size: var(--mv-fs-micro); color: var(--mv-fg-subtle); }

.review { display: flex; flex-direction: column; gap: var(--mv-s-3); }
.reviewBar { display: flex; align-items: center; gap: var(--mv-s-3); flex-wrap: wrap; }
.launch { display: flex; flex-direction: column; gap: var(--mv-s-2); }

.note { font-size: var(--mv-fs-xs); color: var(--mv-fg-muted); }
.note strong { font-weight: var(--mv-fw-medium); color: var(--mv-fg); }
.muted { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); max-width: 60ch; }
.hint { font-size: var(--mv-fs-xs); color: var(--mv-warn); }
.err { font-size: var(--mv-fs-xs); color: var(--mv-danger); }
.empty {
  padding: var(--mv-s-5); border: 1px dashed var(--mv-line); border-radius: var(--mv-r-md);
  font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle);
}

@media (max-width: 720px) {
  .head { flex-direction: column; }
  .overrides { flex-direction: column; }
}
</style>
