<script setup lang="ts">
import type { WireConnection } from '#shared/connection-wire'
import { confirmsDeletion } from '../../utils/connection-form'

/**
 * The second confirmation.
 *
 * Opening this panel is the first — a click that could be a misfire. Typing the
 * connection's own name is the second, and it is the one that carries the
 * weight: it cannot be satisfied by muscle memory, and it forces a reader to
 * look at WHICH row they are on, which is the mistake actually worth
 * preventing in a table where every row looks alike.
 *
 * The panel says what is lost and what is not, because "delete" on a screen
 * full of databases is ambiguous in the one direction that matters. Movy
 * deletes the saved credential and target; it does not touch the database.
 */

const props = defineProps<{
  connection: WireConnection
  deleting: boolean
  error: string | null
}>()

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const typed = ref('')
const armed = computed(() => confirmsDeletion(typed.value, props.connection.name))

const inputId = computed(() => `delete-confirm-${props.connection.id}`)

/**
 * The panel opens with the caret already in the box. The confirmation is a
 * typing task, and leaving the reader to find the field first is the kind of
 * friction that gets solved by pasting the name — which is precisely the habit
 * this gate exists to prevent.
 */
const box = ref<HTMLInputElement | null>(null)
onMounted(() => box.value?.focus())
</script>

<template>
  <div class="panel">
    <p class="warn">
      Deleting <strong class="mv-mono">{{ connection.name }}</strong> removes its stored
      credentials and its test history from Movy. The database itself is untouched, and nothing
      here can be undone.
    </p>

    <form class="confirm" @submit.prevent="armed && emit('confirm')">
      <label :for="inputId" class="mv-label">
        Type <span class="mv-mono echo">{{ connection.name }}</span> to confirm
      </label>
      <div class="row">
        <input
          :id="inputId"
          ref="box"
          v-model="typed"
          class="mv-mono"
          autocomplete="off"
          spellcheck="false"
          :aria-describedby="error ? `${inputId}-error` : undefined"
        />
        <AppButton type="submit" variant="danger" :disabled="!armed || deleting">
          {{ deleting ? 'Deleting…' : 'Delete permanently' }}
        </AppButton>
        <AppButton @click="emit('cancel')">Cancel</AppButton>
      </div>
    </form>

    <p v-if="error" :id="`${inputId}-error`" class="error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: var(--mv-s-3); padding: var(--mv-s-2) 0; }
.warn { color: var(--mv-fg-muted); font-size: var(--mv-fs-xs); max-width: 70ch; line-height: 1.5; }
.warn strong { color: var(--mv-danger); font-weight: var(--mv-fw-medium); }
.confirm { display: flex; flex-direction: column; gap: var(--mv-s-2); }
.echo { text-transform: none; color: var(--mv-fg); }
.row { display: flex; align-items: center; gap: var(--mv-s-2); flex-wrap: wrap; }
input { padding: 6px var(--mv-s-2); border: 1px solid var(--mv-line); border-radius: var(--mv-r-md); background: var(--mv-bg-base); color: var(--mv-fg); font-size: var(--mv-fs-xs); min-width: 200px; }
input:focus { outline: none; box-shadow: var(--mv-focus); border-color: var(--mv-danger); }
.error { color: var(--mv-danger); font-size: var(--mv-fs-xs); }
</style>
