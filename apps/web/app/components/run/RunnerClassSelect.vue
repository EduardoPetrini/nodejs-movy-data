<script setup lang="ts">
import { classSentence, type RunnersSnapshot } from '#shared/runner-wire'

/**
 * Which kind of runner a run goes to. `''` follows whatever the default is
 * (or, on the review screen, whatever the saved migration says), so a
 * definition saved today keeps following the default if it changes later.
 *
 * Each option carries its availability — the same sentence as the runners
 * panel — because "Large" on its own does not say that no Large runner is
 * online and the run would sit in the queue.
 */
const props = withDefaults(defineProps<{ orgSlug: string; disabled?: boolean }>(), { disabled: false })

const model = defineModel<string>({ default: '' })

const { data } = useFetch<RunnersSnapshot>(`/api/orgs/${props.orgSlug}/runners`, {
  key: `runner-classes-${props.orgSlug}`,
})

const classes = computed(() => data.value?.classes ?? [])
/** Names the class it resolves to today, so "default" is never read as a class called Default. */
const followLabel = computed(() => {
  const fallback = classes.value.find((c) => c.isDefault)
  return fallback ? `Use the default (${fallback.label})` : 'Use the default'
})
const selected = computed(() =>
  classes.value.find((c) => (model.value ? c.name === model.value : c.isDefault))
)
const id = useId()
</script>

<template>
  <div class="field">
    <label :for="id" class="mv-label">Runner</label>
    <select :id="id" v-model="model" :disabled="disabled" data-testid="runner-class">
      <option value="">{{ followLabel }}</option>
      <option v-for="c in classes" :key="c.name" :value="c.name">{{ c.label }}</option>
    </select>
    <p v-if="selected" class="state" :data-availability="selected.online === 0 && !selected.onDemand ? 'none' : 'some'">
      {{ selected.label }}: {{ classSentence(selected) }}
    </p>
  </div>
</template>

<style scoped>
.field { display: flex; flex-direction: column; gap: var(--mv-s-1); }
select {
  padding: 6px var(--mv-s-3);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-raised); color: var(--mv-fg);
  font-family: inherit; font-size: var(--mv-fs-sm);
  max-width: 320px;
}
select:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 1px; }
.state { font-size: var(--mv-fs-micro); color: var(--mv-fg-subtle); }
.state[data-availability='none'] { color: var(--mv-warn); }
</style>
