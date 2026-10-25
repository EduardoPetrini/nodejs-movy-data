<script setup lang="ts">
import { scaleSentence, type ScaleResult } from '#shared/runner-wire'

/**
 * "Start a runner", where a missing runner is the reason something waits: a
 * queued run, or a Test or Preview asked of a class with nobody online.
 *
 * Admins only (`runner:scale`), and absent rather than disabled for anyone
 * else: runners are shared by every org, so this is not a choice an editor
 * can make. What it does depends on the deployment — under the manual
 * provisioner it starts nothing and shows the command that would.
 */
const props = defineProps<{ orgSlug: string; runnerClass: string; classLabel: string }>()

const { data: me } = useFetch('/api/me')
const mayScale = computed(
  () => me.value?.orgs.find((o) => o.slug === props.orgSlug)?.permissions.includes('runner:scale') ?? false
)

const busy = ref(false)
const result = ref<ScaleResult | null>(null)
const error = ref<string | null>(null)
const copied = ref(false)

async function start() {
  busy.value = true
  error.value = null
  try {
    result.value = await $fetch<ScaleResult>(`/api/orgs/${props.orgSlug}/runners/scale`, {
      method: 'POST',
      body: { runnerClass: props.runnerClass },
    })
  } catch (err) {
    error.value = (err as { statusMessage?: string }).statusMessage ?? 'The runner could not be started.'
  } finally {
    busy.value = false
  }
}

async function copy(command: string) {
  try {
    await navigator.clipboard.writeText(command)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // Clipboard access can be refused; the command is on screen and selectable.
  }
}
</script>

<template>
  <div v-if="mayScale" class="start" data-testid="start-runner">
    <AppButton v-if="!result || result.status === 'manual'" :disabled="busy" @click="start">
      {{ busy ? 'Starting…' : `Start a ${classLabel} runner` }}
    </AppButton>
    <p v-if="result" class="outcome" role="status" :data-status="result.status">{{ scaleSentence(result, classLabel) }}</p>
    <div v-if="result?.status === 'manual'" class="command">
      <input :value="result.command" readonly class="mv-mono" aria-label="Command to start a runner" @focus="($event.target as HTMLInputElement).select()">
      <AppButton @click="copy(result.command)">{{ copied ? 'Copied' : 'Copy' }}</AppButton>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.start { display: flex; flex-direction: column; align-items: flex-start; gap: var(--mv-s-2); }
.outcome { font-size: var(--mv-fs-xs); color: var(--mv-fg-muted); }
.outcome[data-status='at_capacity'] { color: var(--mv-warn); }
.command { display: flex; gap: var(--mv-s-2); width: 100%; max-width: 36rem; }
.command input {
  flex: 1; min-width: 0;
  padding: 6px var(--mv-s-2);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-sunken); color: var(--mv-fg);
  font-size: var(--mv-fs-xs);
}
.command input:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 1px; }
.error { font-size: var(--mv-fs-xs); color: var(--mv-danger); }
</style>
