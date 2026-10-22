<script setup lang="ts">
import { CONNECTION_ENGINES, type ConnectionInput } from '#shared/connection-wire'
import {
  retargetPort,
  toConnectionInput,
  type ConnectionFormValues,
} from '../../utils/connection-form'

/**
 * One form for creating a connection and for editing one.
 *
 * Two forms would drift, and the drift would be silent: a field added to
 * create and forgotten on edit does not break anything, it just quietly makes
 * that field uneditable forever.
 *
 * The two modes differ in exactly two ways, and both are about identity rather
 * than presentation. The ENGINE is fixed once saved — changing it would leave
 * every field beneath it describing a database of a different dialect, and the
 * PATCH handler does not accept it — so edit shows it as a fact, not a control.
 * And the PASSWORD is required on create and optional on edit, because the
 * stored one is never sent to a client and a blank field means "keep it".
 */

const props = defineProps<{
  mode: 'create' | 'edit'
  values: ConnectionFormValues
  saving: boolean
  error: string | null
  submitLabel: string
  /** Base connections URL for this org, e.g. `/api/orgs/acme/connections`. Only needed in create mode, to test before saving. */
  testBase?: string
}>()

const emit = defineEmits<{
  submit: [input: ConnectionInput]
  cancel: []
}>()

const isEdit = computed(() => props.mode === 'edit')

const engineLabel = computed(
  () => CONNECTION_ENGINES.find((e) => e.value === props.values.engine)?.label ?? props.values.engine
)

/**
 * Test the credentials on screen before there is a row to test against.
 *
 * Only offered in create mode: on edit, a blank password means "keep the
 * stored one", and this form never sees that secret, so a test here could
 * only test the *new* fields against a password the form does not have. The
 * per-row Test button on the list already covers a saved connection.
 */
const testing = ref(false)
const testResult = ref<{ ok: boolean; latencyMs: number | null; error?: string } | null>(null)

async function testConnection() {
  if (!props.testBase) return
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await $fetch<{ ok: boolean; latencyMs: number | null; error?: string }>(
      `${props.testBase}/test`,
      { method: 'POST', body: toConnectionInput(props.values) }
    )
  } catch (err) {
    testResult.value = {
      ok: false,
      latencyMs: null,
      error: (err as { statusMessage?: string }).statusMessage ?? 'Could not run the test.',
    }
  } finally {
    testing.value = false
  }
}

/**
 * Choosing an engine offers its default port — but `retargetPort` refuses to
 * overwrite a port somebody typed, so this is a convenience and never a
 * surprise.
 */
function onEngineChange(engine: string) {
  props.values.engine = engine
  props.values.port = retargetPort(props.values.port, engine)
}

function onSubmit() {
  emit('submit', toConnectionInput(props.values))
}
</script>

<template>
  <form class="form" @submit.prevent="onSubmit">
    <div class="grid">
      <label>
        <span class="mv-label">Name</span>
        <input v-model="values.name" required class="mv-mono" />
      </label>

      <label v-if="!isEdit">
        <span class="mv-label">Engine</span>
        <select
          :value="values.engine"
          class="mv-mono"
          @change="onEngineChange(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="engine in CONNECTION_ENGINES" :key="engine.value" :value="engine.value">
            {{ engine.label }}
          </option>
        </select>
      </label>
      <div v-else class="fixed">
        <span class="mv-label">Engine</span>
        <span class="fixed-value mv-mono">{{ engineLabel }}</span>
        <span class="hint">Fixed once saved</span>
      </div>

      <label>
        <span class="mv-label">Host</span>
        <input v-model="values.host" required class="mv-mono" />
      </label>
      <label>
        <span class="mv-label">Port</span>
        <input v-model.number="values.port" type="number" required class="mv-mono mv-num" />
      </label>
      <label>
        <span class="mv-label">Database</span>
        <input v-model="values.database" required class="mv-mono" />
      </label>
      <label>
        <span class="mv-label">Schema</span>
        <input v-model="values.schemaName" class="mv-mono" placeholder="public" />
      </label>
      <label>
        <span class="mv-label">Username</span>
        <input v-model="values.username" required class="mv-mono" />
      </label>
      <label>
        <span class="mv-label">Password</span>
        <input
          v-model="values.password"
          type="password"
          :required="!isEdit"
          :placeholder="isEdit ? 'Unchanged' : ''"
          autocomplete="new-password"
          class="mv-mono"
        />
        <span v-if="isEdit" class="hint">Leave blank to keep the stored password.</span>
      </label>

      <label class="check">
        <input v-model="values.ssl" type="checkbox" />
        <span>Require TLS</span>
      </label>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <p v-if="testResult" class="test-result" :class="{ ok: testResult.ok }" role="status">
      <StatusDot :status="testResult.ok ? 'ok' : 'failed'" />
      <span v-if="testResult.ok">Connected in {{ testResult.latencyMs }}ms.</span>
      <span v-else>{{ testResult.error ?? 'The test failed, but reported no reason.' }}</span>
    </p>

    <div class="actions">
      <AppButton type="submit" variant="primary" :disabled="saving">
        {{ saving ? 'Saving…' : submitLabel }}
      </AppButton>
      <AppButton v-if="!isEdit && testBase" type="button" :disabled="testing" @click="testConnection">
        {{ testing ? 'Testing…' : 'Test connection' }}
      </AppButton>
      <AppButton v-if="isEdit" @click="emit('cancel')">Cancel</AppButton>
    </div>
  </form>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--mv-s-3); }
label, .fixed { display: flex; flex-direction: column; gap: 3px; }
input, select { padding: 6px var(--mv-s-2); border: 1px solid var(--mv-line); border-radius: var(--mv-r-md); background: var(--mv-bg-sunken); color: var(--mv-fg); font-size: var(--mv-fs-xs); }
input:focus, select:focus { outline: none; box-shadow: var(--mv-focus); border-color: var(--mv-accent); }
.fixed-value { padding: 6px var(--mv-s-2); border: 1px dashed var(--mv-line); border-radius: var(--mv-r-md); color: var(--mv-fg-muted); font-size: var(--mv-fs-xs); }
.hint { color: var(--mv-fg-subtle); font-size: var(--mv-fs-micro); }
.check { flex-direction: row; align-items: center; gap: var(--mv-s-2); align-self: end; padding-bottom: 6px; font-size: var(--mv-fs-xs); color: var(--mv-fg-muted); }
.check input { width: auto; }
.error { color: var(--mv-danger); font-size: var(--mv-fs-xs); margin-top: var(--mv-s-2); }
.test-result { display: flex; align-items: center; gap: var(--mv-s-2); color: var(--mv-danger); font-size: var(--mv-fs-xs); margin-top: var(--mv-s-2); }
.test-result.ok { color: var(--mv-fg-muted); }
.actions { display: flex; gap: var(--mv-s-2); margin-top: var(--mv-s-4); }
</style>
