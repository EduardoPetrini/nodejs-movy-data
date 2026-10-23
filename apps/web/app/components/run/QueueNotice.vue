<script setup lang="ts">
import { queueSentence, type QueueState } from '#shared/queue-wire'

/**
 * Why a queued run has not started. Asked every few seconds while it is
 * queued, because each reason clears on its own — a runner comes online, a
 * slot frees, the destination is released — and none of that is a run event.
 */
const props = defineProps<{ orgSlug: string; runId: string }>()

const POLL_MS = 5000

const queue = ref<QueueState | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

async function poll() {
  try {
    const res = await $fetch<{ queue: QueueState | null }>(`/api/orgs/${props.orgSlug}/runs/${props.runId}/queue`)
    queue.value = res.queue
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
  <p v-if="queue" class="queue" :class="tone" role="status" data-testid="queue-reason" :data-reason="queue.reason">
    <span>{{ queueSentence(queue) }}</span>
    <NuxtLink v-if="queue.blockingRunId" :to="`/o/${orgSlug}/runs/${queue.blockingRunId}`" class="link">
      See that run →
    </NuxtLink>
  </p>
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
</style>
