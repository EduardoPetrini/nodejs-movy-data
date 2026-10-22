<script setup lang="ts">
import type { ConnectionInput, WireConnection } from '#shared/connection-wire'
import { formatDateTime } from '../../../utils/format-datetime'
import { timeValue, type SortColumn } from '../../../utils/table-sort'
import {
  blankConnectionForm,
  connectionFormFor,
  type ConnectionFormValues,
} from '../../../utils/connection-form'

const route = useRoute()
const slug = computed(() => route.params.orgSlug as string)
const base = computed(() => `/api/orgs/${slug.value}/connections`)

const { data, refresh, error } = await useFetch<{ connections: WireConnection[] }>(base, { watch: [slug] })

/**
 * The API is the authority and re-checks every request; this only decides
 * whether a control is on screen at all. A viewer sees the list without the
 * host, so an edit form would be a form with nothing in it.
 */
const { data: me } = await useFetch('/api/me')
const mayWrite = computed(
  () => me.value?.orgs.find((o) => o.slug === slug.value)?.permissions.includes('connection:write') ?? false
)

// ---- ordering ----

type ConnectionSortKey = 'name' | 'lastTest' | 'createdAt'

const sortColumns: SortColumn<WireConnection, ConnectionSortKey>[] = [
  { key: 'name', defaultDirection: 'asc', value: (c) => c.name },
  { key: 'lastTest', defaultDirection: 'desc', value: (c) => timeValue(c.lastTest?.at) },
  { key: 'createdAt', defaultDirection: 'desc', value: (c) => timeValue(c.createdAt) },
]

const connections = computed(() => data.value?.connections ?? [])
/**
 * Newest first by default. The repository still reads alphabetically — that is
 * the order the connection pickers want — so the choice is made here, where it
 * is about this table rather than about every reader of the list.
 */
const { sorted, toggle, directionFor, ariaSortFor } = useTableSort(connections, sortColumns, {
  key: 'createdAt',
  direction: 'desc',
})

// ---- the row drawer ----

/**
 * One drawer per row, one row at a time.
 *
 * Four things want to open under a row — its databases, its edit form, its
 * delete confirmation and the reason its last test failed — and they are
 * mutually exclusive by nature: nobody edits a connection and confirms
 * deleting it at once. Holding a single `{ id, kind }` rather than four
 * booleans is what makes that true structurally, instead of true until someone
 * adds a fifth.
 */
type PanelKind = 'databases' | 'edit' | 'delete' | 'error'

const panel = ref<{ id: string; kind: PanelKind } | null>(null)
const rowError = ref<string | null>(null)

function isOpen(id: string, kind: PanelKind) {
  return panel.value?.id === id && panel.value.kind === kind
}

function openPanel(id: string, kind: PanelKind) {
  rowError.value = null
  panel.value = { id, kind }
}

function closePanel() {
  rowError.value = null
  panel.value = null
}

function togglePanel(id: string, kind: PanelKind) {
  if (isOpen(id, kind)) closePanel()
  else openPanel(id, kind)
}

function messageOf(err: unknown, fallback: string) {
  return (err as { statusMessage?: string }).statusMessage ?? fallback
}

// ---- test ----

const testing = ref<string | null>(null)

/**
 * A failed test opens its own reason.
 *
 * The outcome of pressing Test is a sentence, not a red dot, and the moment
 * somebody wants that sentence is the moment it arrives. Making them hover a
 * tooltip to find out why their migration will not run put the answer one
 * gesture further away than the question.
 */
async function test(id: string) {
  testing.value = id
  rowError.value = null
  try {
    const result = await $fetch<{ ok: boolean }>(`${base.value}/${id}/test`, { method: 'POST' })
    await refresh()
    if (!result.ok) openPanel(id, 'error')
    else if (isOpen(id, 'error')) closePanel()
  } catch (err) {
    // The handler reports a failed connection as data, so reaching here means
    // the request itself failed — a 403, or the server being gone.
    openPanel(id, 'error')
    rowError.value = messageOf(err, 'Could not run the test.')
  } finally {
    testing.value = null
  }
}

// ---- databases ----

const databases = ref<Record<string, string[]>>({})

async function toggleDatabases(id: string) {
  if (isOpen(id, 'databases')) { closePanel(); return }
  openPanel(id, 'databases')
  if (databases.value[id]) return
  try {
    const res = await $fetch<{ databases: string[] }>(`${base.value}/${id}/databases`)
    databases.value = { ...databases.value, [id]: res.databases }
  } catch (err) {
    databases.value = { ...databases.value, [id]: [`— ${messageOf(err, 'failed')}`] }
  }
}

// ---- create ----

const showForm = ref(false)
const createValues = reactive<ConnectionFormValues>(blankConnectionForm())
const creating = ref(false)
const formError = ref<string | null>(null)

function toggleCreate() {
  showForm.value = !showForm.value
  formError.value = null
  if (showForm.value) Object.assign(createValues, blankConnectionForm())
}

async function create(input: ConnectionInput) {
  creating.value = true
  formError.value = null
  try {
    await $fetch(base.value, { method: 'POST', body: input })
    showForm.value = false
    Object.assign(createValues, blankConnectionForm())
    await refresh()
  } catch (err) {
    formError.value = messageOf(err, 'Could not save.')
  } finally {
    creating.value = false
  }
}

// ---- edit ----

const editValues = reactive<ConnectionFormValues>(blankConnectionForm())
const savingEdit = ref(false)

function startEdit(connection: WireConnection) {
  if (isOpen(connection.id, 'edit')) { closePanel(); return }
  Object.assign(editValues, connectionFormFor(connection))
  openPanel(connection.id, 'edit')
}

async function saveEdit(id: string, input: ConnectionInput) {
  savingEdit.value = true
  rowError.value = null
  try {
    await $fetch(`${base.value}/${id}`, { method: 'PATCH', body: input })
    await refresh()
    closePanel()
  } catch (err) {
    rowError.value = messageOf(err, 'Could not save.')
  } finally {
    savingEdit.value = false
  }
}

// ---- delete ----

const deleting = ref<string | null>(null)

async function remove(id: string) {
  deleting.value = id
  rowError.value = null
  try {
    await $fetch(`${base.value}/${id}`, { method: 'DELETE' })
    await refresh()
    closePanel()
  } catch (err) {
    // A 409 here is the database refusing to orphan a saved migration, and the
    // handler has already counted them. That is the whole answer — keep the
    // panel open so it is read next to the name it is about.
    rowError.value = messageOf(err, 'Could not delete that connection.')
  } finally {
    deleting.value = null
  }
}
</script>

<template>
  <div>
    <header class="head">
      <div>
        <h1>Connections</h1>
        <p class="sub">Saved databases this organisation can migrate between.</p>
      </div>
      <AppButton v-if="mayWrite" variant="primary" @click="toggleCreate">
        {{ showForm ? 'Cancel' : 'New connection' }}
      </AppButton>
    </header>

    <p v-if="error" class="denied">
      You do not have access to connections in this organisation.
    </p>

    <ConnectionForm
      v-if="showForm"
      class="create"
      mode="create"
      :values="createValues"
      :saving="creating"
      :error="formError"
      :test-base="base"
      submit-label="Save connection"
      @submit="create"
    />

    <div v-if="connections.length" class="mv-scroll-x">
      <table class="grid-table">
        <thead>
          <tr>
            <th :aria-sort="ariaSortFor('name')">
              <SortHeader label="Name" :direction="directionFor('name')" @toggle="toggle('name')" />
            </th>
            <th class="mv-label">Pair</th>
            <th class="mv-label">Target</th>
            <th :aria-sort="ariaSortFor('lastTest')">
              <SortHeader label="Last test" :direction="directionFor('lastTest')" @toggle="toggle('lastTest')" />
            </th>
            <th :aria-sort="ariaSortFor('createdAt')">
              <SortHeader label="Created" :direction="directionFor('createdAt')" @toggle="toggle('createdAt')" />
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          <template v-for="c in sorted" :key="c.id">
            <tr>
              <td class="mv-mono name">{{ c.name }}</td>
              <td><PairChip :source="c.engine" /></td>
              <td class="mv-mono target">
                <template v-if="c.host">{{ c.host }}:{{ c.port }}/{{ c.database }}</template>
                <template v-else>{{ c.database }}</template>
              </td>
              <td class="test">
                <template v-if="c.lastTest">
                  <StatusDot :status="c.lastTest.ok ? 'ok' : 'failed'" />
                  <span v-if="c.lastTest.ok" class="mv-num">{{ c.lastTest.latencyMs }}ms</span>
                  <button
                    v-else
                    type="button"
                    class="fail"
                    :aria-expanded="isOpen(c.id, 'error')"
                    @click="togglePanel(c.id, 'error')"
                  >
                    failed
                  </button>
                </template>
                <span v-else class="never">never</span>
              </td>
              <td class="mv-num created">{{ formatDateTime(c.createdAt) }}</td>
              <td class="actions">
                <AppButton :disabled="testing === c.id" @click="test(c.id)">
                  {{ testing === c.id ? 'Testing…' : 'Test' }}
                </AppButton>
                <AppButton
                  :aria-expanded="isOpen(c.id, 'databases')"
                  @click="toggleDatabases(c.id)"
                >
                  {{ isOpen(c.id, 'databases') ? 'Hide' : 'Databases' }}
                </AppButton>
                <AppButton v-if="mayWrite" :aria-expanded="isOpen(c.id, 'edit')" @click="startEdit(c)">
                  {{ isOpen(c.id, 'edit') ? 'Close' : 'Edit' }}
                </AppButton>
                <AppButton
                  v-if="mayWrite"
                  variant="danger"
                  :aria-expanded="isOpen(c.id, 'delete')"
                  @click="togglePanel(c.id, 'delete')"
                >
                  Delete
                </AppButton>
              </td>
            </tr>

            <tr v-if="panel?.id === c.id" class="drawer">
              <td colspan="6">
                <div v-if="isOpen(c.id, 'databases')">
                  <div v-if="databases[c.id]" class="dbs">
                    <span v-for="db in databases[c.id]" :key="db" class="db mv-mono">{{ db }}</span>
                  </div>
                  <span v-else class="never">Loading…</span>
                </div>

                <p v-else-if="isOpen(c.id, 'error')" class="fail-detail" role="alert">
                  {{ rowError ?? c.lastTest?.error ?? 'The test failed, but reported no reason.' }}
                </p>

                <ConnectionForm
                  v-else-if="isOpen(c.id, 'edit')"
                  mode="edit"
                  :values="editValues"
                  :saving="savingEdit"
                  :error="rowError"
                  submit-label="Save changes"
                  @submit="saveEdit(c.id, $event)"
                  @cancel="closePanel"
                />

                <DeleteConnectionPanel
                  v-else-if="isOpen(c.id, 'delete')"
                  :connection="c"
                  :deleting="deleting === c.id"
                  :error="rowError"
                  @confirm="remove(c.id)"
                  @cancel="closePanel"
                />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <p v-else-if="!error" class="empty">
      No connections yet. Add one to start building a migration.
    </p>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--mv-s-4); margin-bottom: var(--mv-s-5); }
h1 { font-size: var(--mv-fs-lg); }
.sub { color: var(--mv-fg-subtle); font-size: var(--mv-fs-xs); margin-top: 2px; }

.create { margin-bottom: var(--mv-s-5); padding: var(--mv-s-4); background: var(--mv-bg-base); border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg); box-shadow: var(--mv-elev-1); }

.grid-table { width: 100%; border-collapse: collapse; font-size: var(--mv-fs-xs); }
th { text-align: left; padding: 0 var(--mv-s-3) var(--mv-s-2); border-bottom: 1px solid var(--mv-line); }
td { height: var(--mv-row-h); padding: 0 var(--mv-s-3); border-bottom: 1px solid var(--mv-line); vertical-align: middle; }
tbody tr:hover td { background: var(--mv-bg-base); }
.name { color: var(--mv-fg); font-weight: var(--mv-fw-medium); }
.target { color: var(--mv-fg-muted); }
.created { color: var(--mv-fg-subtle); white-space: nowrap; }
.test { display: flex; align-items: center; gap: var(--mv-s-2); height: var(--mv-row-h); color: var(--mv-fg-muted); }
.test .mv-num { font-family: var(--mv-font-mono); }
.never { color: var(--mv-fg-subtle); }
.actions { display: flex; gap: var(--mv-s-2); justify-content: flex-end; }

.fail {
  padding: 0; border: 0; background: none; cursor: pointer;
  color: var(--mv-danger); font: inherit;
  text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px;
}
.fail:hover { text-decoration-style: solid; }
.fail:focus-visible { outline: none; box-shadow: var(--mv-focus); border-radius: var(--mv-r-sm); }

.drawer td { background: var(--mv-bg-sunken); padding-top: var(--mv-s-3); padding-bottom: var(--mv-s-3); height: auto; }
.dbs { display: flex; flex-wrap: wrap; gap: var(--mv-s-2); }
.db { padding: 2px 7px; border: 1px solid var(--mv-line); border-radius: var(--mv-r-sm); color: var(--mv-fg-muted); }
.fail-detail { color: var(--mv-danger); font-size: var(--mv-fs-xs); line-height: 1.5; max-width: 90ch; white-space: pre-wrap; }

.empty, .denied { color: var(--mv-fg-subtle); font-size: var(--mv-fs-sm); }
.denied { color: var(--mv-warn); }
</style>
