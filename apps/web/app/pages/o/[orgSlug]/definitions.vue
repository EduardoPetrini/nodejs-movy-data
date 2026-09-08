<script setup lang="ts">
import type { WireDefinition } from '#shared/definition-wire'
import type { RunMode } from '#shared/pair-capability'

/**
 * Saved migrations: the thing that makes a run repeatable.
 *
 * Before this, a run was assembled from two dropdowns and nothing about it
 * survived except the outcome. A definition is the same choice written down,
 * so it can be reviewed, re-run and — from Phase 4 — charted over time.
 */

const route = useRoute()
const orgSlug = route.params.orgSlug as string

const { data: me } = await useFetch('/api/me')
const org = computed(() => me.value?.orgs.find((o) => o.slug === orgSlug))
const mayWrite = computed(() => org.value?.permissions.includes('definition:write') ?? false)
const mayRun = computed(() => org.value?.permissions.includes('run:execute') ?? false)
/** Viewers cannot read connections at all, so the form has nothing to offer them. */
const mayReadConnections = computed(() => org.value?.permissions.includes('connection:read') ?? false)

const { data, refresh } = await useFetch<{ definitions: WireDefinition[] }>(
  `/api/orgs/${orgSlug}/definitions`
)
const { data: connectionData } = await useFetch<{
  connections: { id: string; name: string; engine: string; database: string }[]
}>(`/api/orgs/${orgSlug}/connections`, { immediate: mayReadConnections.value })

const connections = computed(() => connectionData.value?.connections ?? [])
const definitions = computed(() => data.value?.definitions ?? [])

// ---- the form ----

const emptyForm = () => ({
  name: '',
  description: '',
  sourceConnectionId: '',
  targetConnectionId: '',
  sourceDatabase: '',
  targetDatabase: '',
  mode: 'full' as RunMode,
  querySql: '',
  targetTableName: '',
})

const form = reactive(emptyForm())
/** Null when closed, '' when creating, an id when editing. */
const editing = ref<string | null>(null)
const saving = ref(false)
const formError = ref<string | null>(null)
const selectable = ref<{ ok: boolean; reason?: string }>({ ok: false })

const open = computed(() => editing.value !== null)

function startCreate() {
  Object.assign(form, emptyForm())
  formError.value = null
  editing.value = ''
}

function startEdit(definition: WireDefinition) {
  Object.assign(form, {
    name: definition.name,
    description: definition.description ?? '',
    sourceConnectionId: definition.source.connectionId,
    targetConnectionId: definition.target.connectionId,
    // Only a pinned database goes back into the field. Echoing the
    // connection's own would silently pin it on the next save.
    sourceDatabase: definition.source.pinned ? definition.source.database : '',
    targetDatabase: definition.target.pinned ? definition.target.database : '',
    mode: definition.mode,
    querySql: definition.querySql ?? '',
    targetTableName: definition.targetTableName ?? '',
  })
  formError.value = null
  editing.value = definition.id
}

function close() {
  editing.value = null
  formError.value = null
}

async function save() {
  formError.value = null
  saving.value = true
  try {
    const path = editing.value
      ? `/api/orgs/${orgSlug}/definitions/${editing.value}`
      : `/api/orgs/${orgSlug}/definitions`
    await $fetch(path, { method: editing.value ? 'PATCH' : 'POST', body: { ...form } })
    await refresh()
    close()
  } catch (err) {
    formError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not save.'
  } finally {
    saving.value = false
  }
}

const archiving = ref<string | null>(null)

async function archive(definition: WireDefinition) {
  // A definition is retired, not deleted — its runs keep pointing at it. Worth
  // saying in the confirmation, so "Archive" does not read as a euphemism.
  const confirmed = confirm(
    `Archive "${definition.name}"? It disappears from this list; the runs it produced keep their history.`
  )
  if (!confirmed) return

  archiving.value = definition.id
  try {
    await $fetch(`/api/orgs/${orgSlug}/definitions/${definition.id}`, { method: 'DELETE' })
    await refresh()
  } catch (err) {
    formError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not archive.'
  } finally {
    archiving.value = null
  }
}
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>Migrations</h1>
        <p class="sub">Saved source-to-destination routes, ready to review and run.</p>
      </div>
      <AppButton v-if="mayWrite && !open" variant="primary" @click="startCreate">
        New migration
      </AppButton>
    </header>

    <section v-if="open" class="editor" aria-labelledby="editor-heading">
      <h2 id="editor-heading" class="mv-label">
        {{ editing ? 'Edit migration' : 'New migration' }}
      </h2>

      <label class="field">
        <span class="mv-label">Name</span>
        <input v-model="form.name" type="text" placeholder="Nightly reporting copy" maxlength="80">
      </label>

      <label class="field">
        <span class="mv-label">Description <em>optional</em></span>
        <input v-model="form.description" type="text" maxlength="500">
      </label>

      <PairSelector
        v-model:source-id="form.sourceConnectionId"
        v-model:target-id="form.targetConnectionId"
        v-model:mode="form.mode"
        :connections="connections"
        offer-mode
        intent="save"
        @availability="selectable = $event"
      />

      <div class="overrides">
        <label class="field">
          <span class="mv-label">Source database <em>optional override</em></span>
          <input v-model="form.sourceDatabase" type="text" placeholder="follow the connection">
        </label>
        <label class="field">
          <span class="mv-label">Destination database <em>optional override</em></span>
          <input v-model="form.targetDatabase" type="text" placeholder="follow the connection">
        </label>
      </div>

      <template v-if="form.mode === 'query'">
        <label class="field">
          <span class="mv-label">SQL</span>
          <textarea v-model="form.querySql" rows="5" spellcheck="false" class="mv-mono" />
        </label>
        <label class="field">
          <span class="mv-label">Destination table</span>
          <input v-model="form.targetTableName" type="text" class="mv-mono" placeholder="order_totals">
        </label>
      </template>

      <p v-if="!selectable.ok && selectable.reason" class="hint">{{ selectable.reason }}</p>
      <p v-if="formError" class="err">{{ formError }}</p>

      <div class="actions">
        <AppButton variant="primary" :disabled="saving || !selectable.ok || !form.name" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
        </AppButton>
        <AppButton :disabled="saving" @click="close">Cancel</AppButton>
      </div>
    </section>

    <p v-if="definitions.length === 0" class="empty">
      Nothing saved yet.<template v-if="mayWrite"> Create one above and it becomes repeatable.</template>
    </p>

    <ul v-else class="list">
      <li v-for="d in definitions" :key="d.id" class="row">
        <div class="identity">
          <span class="name">{{ d.name }}</span>
          <span v-if="d.mode === 'query'" class="tag">query</span>
          <p v-if="d.description" class="desc">{{ d.description }}</p>
        </div>

        <div class="route">
          <PairChip :source="d.source.engine" :target="d.target.engine" />
          <span class="dbs mv-mono">{{ d.source.database }} → {{ d.target.database }}</span>
        </div>

        <div class="rowActions">
          <NuxtLink
            v-if="mayRun"
            :to="`/o/${orgSlug}/runs/new?definition=${d.id}`"
            class="reviewLink"
          >
            Review &amp; run
          </NuxtLink>
          <AppButton v-if="mayWrite" @click="startEdit(d)">Edit</AppButton>
          <AppButton
            v-if="mayWrite"
            variant="danger"
            :disabled="archiving === d.id"
            @click="archive(d)"
          >
            {{ archiving === d.id ? 'Archiving…' : 'Archive' }}
          </AppButton>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: var(--mv-s-5); max-width: 1100px; }

.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--mv-s-4); }
.head h1 { font-size: var(--mv-fs-lg); letter-spacing: -0.015em; }
.sub { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); margin-top: var(--mv-s-1); }

.editor {
  display: flex; flex-direction: column; gap: var(--mv-s-3);
  padding: var(--mv-s-4);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg);
  background: var(--mv-bg-base); box-shadow: var(--mv-elev-1);
}
.field { display: flex; flex-direction: column; gap: var(--mv-s-1); }
.field em { font-style: normal; opacity: 0.65; text-transform: none; letter-spacing: 0; }
.field input, .field textarea {
  padding: 6px var(--mv-s-3);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-raised); color: var(--mv-fg);
  font-family: inherit; font-size: var(--mv-fs-sm);
}
.field textarea { resize: vertical; line-height: var(--mv-lh-log); }
.field input:focus-visible, .field textarea:focus-visible {
  outline: 2px solid var(--mv-focus); outline-offset: 1px;
}
.overrides { display: flex; gap: var(--mv-s-4); flex-wrap: wrap; }
.overrides .field { flex: 1; min-width: 220px; }

.actions { display: flex; gap: var(--mv-s-2); }
.hint { font-size: var(--mv-fs-xs); color: var(--mv-warn); }
.err { font-size: var(--mv-fs-xs); color: var(--mv-danger); }

.empty {
  padding: var(--mv-s-5); border: 1px dashed var(--mv-line); border-radius: var(--mv-r-md);
  font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle);
}

.list {
  list-style: none; margin: 0; padding: 0;
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg); overflow: hidden;
}
.list li + li { border-top: 1px solid var(--mv-line); }
.row {
  display: flex; align-items: center; gap: var(--mv-s-4);
  padding: var(--mv-s-3) var(--mv-s-4);
  background: var(--mv-bg-base);
  transition: background var(--mv-dur-1) var(--mv-ease-out);
}
.row:hover { background: var(--mv-bg-raised); }

.identity { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--mv-s-2); flex-wrap: wrap; }
.name { font-size: var(--mv-fs-sm); font-weight: var(--mv-fw-medium); }
.desc { flex-basis: 100%; font-size: var(--mv-fs-micro); color: var(--mv-fg-subtle); }
.tag {
  font-size: var(--mv-fs-micro); text-transform: uppercase; letter-spacing: var(--mv-track-label);
  padding: 1px 5px; border-radius: var(--mv-r-sm);
  background: var(--mv-accent-dim); color: var(--mv-accent);
}

.route { display: flex; flex-direction: column; gap: 2px; }
.dbs { font-size: var(--mv-fs-micro); color: var(--mv-fg-subtle); }

.rowActions { display: flex; align-items: center; gap: var(--mv-s-2); }
.reviewLink {
  font-size: var(--mv-fs-xs); color: var(--mv-accent); text-decoration: none;
  padding: 6px var(--mv-s-2); border-radius: var(--mv-r-md);
  transition: background var(--mv-dur-1) var(--mv-ease-out);
}
.reviewLink:hover { background: var(--mv-accent-dim); text-decoration: none; }
.reviewLink:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 1px; }

@media (max-width: 720px) {
  .row { flex-direction: column; align-items: stretch; gap: var(--mv-s-2); }
  .head { flex-direction: column; }
}
</style>
