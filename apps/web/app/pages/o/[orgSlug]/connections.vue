<script setup lang="ts">
import { formatDateTime } from '../../../utils/format-datetime'
import { timeValue, type SortColumn } from '../../../utils/table-sort'

const route = useRoute()
const slug = computed(() => route.params.orgSlug as string)
const base = computed(() => `/api/orgs/${slug.value}/connections`)

const { data, refresh, error } = await useFetch<{ connections: PublicConnection[] }>(base, { watch: [slug] })

interface PublicConnection {
  id: string; name: string; engine: string; database: string; schemaName: string
  createdAt: string
  host?: string; port?: number; username?: string
  lastTest: { at: string; ok: boolean; latencyMs: number | null; error: string | null } | null
}

// ---- ordering ----

type ConnectionSortKey = 'name' | 'lastTest' | 'createdAt'

const sortColumns: SortColumn<PublicConnection, ConnectionSortKey>[] = [
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

const testing = ref<string | null>(null)
const expanded = ref<string | null>(null)
const databases = ref<Record<string, string[]>>({})

async function test(id: string) {
  testing.value = id
  try { await $fetch(`${base.value}/${id}/test`, { method: 'POST' }); await refresh() }
  finally { testing.value = null }
}

async function toggleDatabases(id: string) {
  if (expanded.value === id) { expanded.value = null; return }
  expanded.value = id
  if (databases.value[id]) return
  try {
    const res = await $fetch<{ databases: string[] }>(`${base.value}/${id}/databases`)
    databases.value = { ...databases.value, [id]: res.databases }
  } catch (err) {
    databases.value = { ...databases.value, [id]: [`— ${(err as { statusMessage?: string }).statusMessage ?? 'failed'}`] }
  }
}

const showForm = ref(false)
const form = reactive({ name: '', engine: 'postgres', host: 'localhost', port: 5432, database: '', username: '', password: '', ssl: false })
const saving = ref(false)
const formError = ref<string | null>(null)

async function save() {
  saving.value = true
  formError.value = null
  try {
    await $fetch(base.value, { method: 'POST', body: form })
    showForm.value = false
    Object.assign(form, { name: '', database: '', username: '', password: '' })
    await refresh()
  } catch (err) {
    formError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not save.'
  } finally {
    saving.value = false
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
      <AppButton variant="primary" @click="showForm = !showForm">
        {{ showForm ? 'Cancel' : 'New connection' }}
      </AppButton>
    </header>

    <p v-if="error" class="denied">
      You do not have access to connections in this organisation.
    </p>

    <form v-if="showForm" class="form" @submit.prevent="save">
      <div class="grid">
        <label><span class="mv-label">Name</span><input v-model="form.name" required class="mv-mono" /></label>
        <label><span class="mv-label">Engine</span>
          <select v-model="form.engine" class="mv-mono">
            <option value="postgres">PostgreSQL</option>
            <option value="mysql">MySQL</option>
            <option value="mssql">SQL Server</option>
          </select>
        </label>
        <label><span class="mv-label">Host</span><input v-model="form.host" required class="mv-mono" /></label>
        <label><span class="mv-label">Port</span><input v-model.number="form.port" type="number" required class="mv-mono mv-num" /></label>
        <label><span class="mv-label">Database</span><input v-model="form.database" required class="mv-mono" /></label>
        <label><span class="mv-label">Username</span><input v-model="form.username" required class="mv-mono" /></label>
        <label><span class="mv-label">Password</span><input v-model="form.password" type="password" required class="mv-mono" /></label>
        <label class="check"><input v-model="form.ssl" type="checkbox" /><span>Require TLS</span></label>
      </div>
      <p v-if="formError" class="error">{{ formError }}</p>
      <AppButton type="submit" variant="primary" :disabled="saving">{{ saving ? 'Saving…' : 'Save connection' }}</AppButton>
    </form>

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
                  <span v-else class="fail" :title="c.lastTest.error ?? ''">failed</span>
                </template>
                <span v-else class="never">never</span>
              </td>
              <td class="mv-num created">{{ formatDateTime(c.createdAt) }}</td>
              <td class="actions">
                <AppButton :disabled="testing === c.id" @click="test(c.id)">
                  {{ testing === c.id ? 'Testing…' : 'Test' }}
                </AppButton>
                <AppButton @click="toggleDatabases(c.id)">
                  {{ expanded === c.id ? 'Hide' : 'Databases' }}
                </AppButton>
              </td>
            </tr>
            <tr v-if="expanded === c.id" class="drawer">
              <td colspan="6">
                <div v-if="databases[c.id]" class="dbs">
                  <span v-for="db in databases[c.id]" :key="db" class="db mv-mono">{{ db }}</span>
                </div>
                <span v-else class="never">Loading…</span>
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

.form { margin-bottom: var(--mv-s-5); padding: var(--mv-s-4); background: var(--mv-bg-base); border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg); box-shadow: var(--mv-elev-1); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--mv-s-3); }
label { display: flex; flex-direction: column; gap: 3px; }
input, select { padding: 6px var(--mv-s-2); border: 1px solid var(--mv-line); border-radius: var(--mv-r-md); background: var(--mv-bg-sunken); color: var(--mv-fg); font-size: var(--mv-fs-xs); }
input:focus, select:focus { outline: none; box-shadow: var(--mv-focus); border-color: var(--mv-accent); }
.check { flex-direction: row; align-items: center; gap: var(--mv-s-2); align-self: end; padding-bottom: 6px; font-size: var(--mv-fs-xs); color: var(--mv-fg-muted); }
.check input { width: auto; }
.form :deep(button) { margin-top: var(--mv-s-4); }
.error { color: var(--mv-danger); font-size: var(--mv-fs-xs); margin-top: var(--mv-s-2); }

.grid-table { width: 100%; border-collapse: collapse; font-size: var(--mv-fs-xs); }
th { text-align: left; padding: 0 var(--mv-s-3) var(--mv-s-2); border-bottom: 1px solid var(--mv-line); }
td { height: var(--mv-row-h); padding: 0 var(--mv-s-3); border-bottom: 1px solid var(--mv-line); vertical-align: middle; }
tbody tr:hover td { background: var(--mv-bg-base); }
.name { color: var(--mv-fg); font-weight: var(--mv-fw-medium); }
.target { color: var(--mv-fg-muted); }
.created { color: var(--mv-fg-subtle); white-space: nowrap; }
.test { display: flex; align-items: center; gap: var(--mv-s-2); height: var(--mv-row-h); color: var(--mv-fg-muted); }
.test .mv-num { font-family: var(--mv-font-mono); }
.fail { color: var(--mv-danger); }
.never { color: var(--mv-fg-subtle); }
.actions { display: flex; gap: var(--mv-s-2); justify-content: flex-end; }

.drawer td { background: var(--mv-bg-sunken); padding-top: var(--mv-s-2); padding-bottom: var(--mv-s-2); }
.dbs { display: flex; flex-wrap: wrap; gap: var(--mv-s-2); }
.db { padding: 2px 7px; border: 1px solid var(--mv-line); border-radius: var(--mv-r-sm); color: var(--mv-fg-muted); }

.empty, .denied { color: var(--mv-fg-subtle); font-size: var(--mv-fs-sm); }
.denied { color: var(--mv-warn); }
</style>
