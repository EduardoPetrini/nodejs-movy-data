<script setup lang="ts">
import { queueSentence, type QueueState } from '#shared/queue-wire'

/**
 * Why a queued run has not started. Asked every few seconds while it is
 * queued, because each reason clears on its own — a runner comes online, a
 * slot frees, the destination is released — and none of that is a run event.
 */
const props = defineProps<{ orgSlug: string; runId: string }>()
/** It is no longer queued — claimed, or cancelled from somewhere else. */
const emit = defineEmits<{ left: [] }>()

const POLL_MS = 5000

const queue = ref<QueueState | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

async function poll() {
  try {
    const res = await $fetch<{ queue: QueueState | null }>(`/api/orgs/${props.orgSlug}/runs/${props.runId}/queue`)
    queue.value = res.queue
    if (res.queue === null) {
      emit('left')
      return
    }
  } catch {
    // A missed poll keeps the last answer; the next one corrects it.
  }
  if (!stopped) timer = setTimeout(poll, POLL_MS)
}

onMounted(poll)
onBeforeUnmount(() => { stopped = true; if (timer) clearTimeout(timer) })

const tone = computed(() => (queue.value?.reason === 'no_runner' ? 'warn' : 'info'))
</script>

<template>
  <div v-if="queue" class="queue" :class="tone" data-testid="queue-reason" :data-reason="queue.reason">
    <span role="status">{{ queueSentence(queue) }}</span>
    <NuxtLink v-if="queue.blockingRunId" :to="`/o/${orgSlug}/runs/${queue.blockingRunId}`" class="link">
      See that run →
    </NuxtLink>
    <!-- The one reason that never clears by itself. -->
    <StartRunner
      v-if="queue.reason === 'no_runner'"
      class="offer"
      :org-slug="orgSlug"
      :runner-class="queue.runnerClass"
      :class-label="queue.classLabel"
    />
  </div>
</template>

<style scoped>
.queue {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--mv-s-2) var(--mv-s-3);
  padding: var(--mv-s-3) var(--mv-s-4);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-base);
  font-size: var(--mv-fs-xs); color: var(--mv-fg-muted);
}
.queue.warn { border-color: var(--mv-warn); background: var(--mv-warn-dim); color: var(--mv-fg); }
.link { font-weight: var(--mv-fw-semibold); }
.offer { flex-basis: 100%; }
</style>
