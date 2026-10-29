<script setup lang="ts">
import { classSentence, type RunnersSnapshot } from '#shared/runner-wire'
import { WEB_VIA } from '#shared/probe-via'

/**
 * Where a Test or a Preview runs: the console (the default, and the fastest)
 * or a runner class. Runners can sit on a different network from the console,
 * so "it connects from here" says nothing about whether a `large` runner can
 * reach the same host — this is how to find out before a run fails on it.
 *
 * Shares the runners snapshot the class selector fetches, so each class shows
 * whether anything of it is online to answer.
 */
const props = withDefaults(defineProps<{ orgSlug: string; label?: string; disabled?: boolean }>(), {
  label: 'Test from',
  disabled: false,
})

const model = defineModel<string>({ default: WEB_VIA })

const { data } = useFetch<RunnersSnapshot>(`/api/orgs/${props.orgSlug}/runners`, {
  key: `runner-classes-${props.orgSlug}`,
})

const classes = computed(() => data.value?.classes ?? [])
const selected = computed(() => classes.value.find((c) => c.name === model.value))
const id = useId()
</script>

<template>
  <div class="via">
    <label :for="id" class="mv-label">{{ label }}</label>
    <select :id="id" v-model="model" :disabled="disabled" data-testid="probe-via">
      <option :value="WEB_VIA">The console</option>
      <option v-for="c in classes" :key="c.name" :value="c.name">{{ c.label }} runner</option>
    </select>
    <span v-if="selected" class="state" :data-availability="selected.online === 0 && !selected.onDemand ? 'none' : 'some'">
      {{ classSentence(selected) }}
    </span>
    <!-- Asking a class with nobody online is an immediate 503; this is the way out.
         Not for an on-demand class: asking it IS how a runner gets started. -->
    <StartRunner
      v-if="selected && selected.online === 0 && !selected.onDemand"
      class="offer"
      :org-slug="orgSlug"
      :runner-class="selected.name"
      :class-label="selected.label"
    />
  </div>
</template>

<style scoped>
.via { display: inline-flex; align-items: center; flex-wrap: wrap; gap: var(--mv-s-2); }
select {
  padding: 4px var(--mv-s-2);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-raised); color: var(--mv-fg);
  font-family: inherit; font-size: var(--mv-fs-sm);
}
select:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 1px; }
.state { font-size: var(--mv-fs-micro); color: var(--mv-fg-subtle); }
.state[data-availability='none'] { color: var(--mv-warn); }
.offer { flex-basis: 100%; }
</style>
