<script setup lang="ts">
import { isTerminal } from '#shared/run-wire'

const route = useRoute()
const orgSlug = route.params.orgSlug as string
const runId = route.params.runId as string

const { data: me } = await useFetch('/api/me')
const mayCancel = computed(() => me.value?.orgs.find((o) => o.slug === orgSlug)?.permissions.includes('run:cancel') ?? false)

const { state, status, detail } = useRunStream(orgSlug, runId)

const cancelling = ref(false)
async function cancel() {
  cancelling.value = true
  try {
    await $fetch(`/api/orgs/${orgSlug}/runs/${runId}/cancel`, { method: 'POST' })
  } finally {
    cancelling.value = false
  }
}

const canCancel = computed(
  () => mayCancel.value && state.value.run !== null && !isTerminal(state.value.run.status)
)
</script>

<template>
  <div class="page">
    <NuxtLink :to="`/o/${orgSlug}/runs`" class="back">← All runs</NuxtLink>

    <p v-if="status === 'revoked'" class="notice danger">{{ detail }}</p>
    <p v-else-if="!state.run" class="notice">
      {{ status === 'failed' ? detail : 'Connecting to the run…' }}
    </p>

    <template v-if="state.run">
      <RunHeader :run="state.run" :live="status === 'live'">
        <template #actions>
          <AppButton v-if="canCancel" variant="danger" :disabled="cancelling" @click="cancel">
            {{ state.run.status === 'cancelling' ? 'Cancelling…' : 'Cancel' }}
          </AppButton>
        </template>
      </RunHeader>

      <!-- Cancellation is cooperative: the orchestrator only observes the abort
           at a step boundary, so saying so beats a spinner that looks stuck. -->
      <p v-if="state.run.status === 'cancelling'" class="notice">
        Cancelling — the run stops at the next step boundary. An in-flight copy
        or index build cannot be interrupted.
      </p>

      <div class="panes">
        <RunTimeline :steps="state.steps" />
        <TableProgressGrid :tables="state.tables" />
      </div>

      <LogStream :lines="state.logs" :withheld="state.logsWithheld" />
    </template>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: var(--mv-s-5); max-width: 1100px; }

.back { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); width: fit-content; }
.back:hover { color: var(--mv-fg-muted); text-decoration: none; }

.notice {
  padding: var(--mv-s-3) var(--mv-s-4);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-base);
  font-size: var(--mv-fs-xs); color: var(--mv-fg-muted);
}
.notice.danger { border-color: var(--mv-danger); background: var(--mv-danger-dim); color: var(--mv-danger); }

/* Timeline and tables sit side by side; the timeline is fixed-ish and the
   grid takes the slack, because table names are the variable-width thing. */
.panes {
  display: grid;
  grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
  gap: var(--mv-s-6);
  align-items: start;
}

@media (max-width: 860px) {
  .panes { grid-template-columns: minmax(0, 1fr); gap: var(--mv-s-5); }
}
</style>
