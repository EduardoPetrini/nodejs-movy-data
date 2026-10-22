<script setup lang="ts">
import type { RunMode } from '#shared/pair-capability'

/**
 * Choosing a source and a destination, with every unsupported combination
 * disabled and the reason on screen.
 *
 * The plan's rule for this component: never a runtime failure. A Planned
 * engine, a route that does not exist and a mode this app cannot drive are all
 * refused here, in the same words the API would refuse them — because both
 * sides call `#shared/pair-capability`. A disabled control with no explanation
 * is its own kind of bug, so each one carries its sentence.
 */

export interface SelectableConnection {
  id: string
  name: string
  engine: string
  database: string
}

const props = withDefaults(
  defineProps<{
    connections: SelectableConnection[]
    /** Shown only where the surface can actually offer it. */
    offerMode?: boolean
    /** `save` allows a query definition the CLI can run; `launch` is stricter. */
    intent?: 'save' | 'launch'
  }>(),
  { offerMode: false, intent: 'launch' }
)

const emit = defineEmits<{ availability: [{ ok: boolean; reason?: string }] }>()

const sourceId = defineModel<string>('sourceId', { default: '' })
const targetId = defineModel<string>('targetId', { default: '' })
const mode = defineModel<RunMode>('mode', { default: 'full' })

const pairs = usePairs()

const engineOf = (id: string): string | undefined =>
  props.connections.find((c) => c.id === id)?.engine

const sourceEngine = computed(() => engineOf(sourceId.value))
const targetEngine = computed(() => engineOf(targetId.value))

/**
 * A connection on a Planned engine is listed but not selectable.
 *
 * Hiding it would be worse: someone who saved a Snowflake connection would
 * find it silently missing and have no way to learn why.
 */
function connectionState(connection: SelectableConnection) {
  const availability = pairs.forEngine(connection.engine)
  return { disabled: !availability.ok, reason: availability.ok ? undefined : availability.reason }
}

const routeAvailability = computed(() => pairs.forRoute(sourceEngine.value, targetEngine.value))

const check = (candidate: RunMode) =>
  props.intent === 'save'
    ? pairs.forSaving(sourceEngine.value, targetEngine.value, candidate)
    : pairs.forLaunching(sourceEngine.value, targetEngine.value, candidate)

const fullAvailability = computed(() => check('full'))
const queryAvailability = computed(() => check('query'))

/** What the parent needs: may this selection be acted on, and if not, why. */
const availability = computed(() =>
  mode.value === 'query' ? queryAvailability.value : fullAvailability.value
)

watchEffect(() => {
  const current = availability.value
  emit('availability', current.ok ? { ok: true } : { ok: false, reason: current.reason })
})

// Leaving the form in a mode the button can only refuse helps nobody, so an
// unavailable mode falls back rather than sticks.
watch(queryAvailability, (next) => {
  if (mode.value === 'query' && !next.ok) mode.value = 'full'
})
</script>

<template>
  <div class="selector">
    <div class="ends">
      <label class="field">
        <span class="mv-label">Source</span>
        <select v-model="sourceId">
          <option value="" disabled>Choose a connection</option>
          <option
            v-for="c in connections"
            :key="c.id"
            :value="c.id"
            :disabled="connectionState(c).disabled"
            :title="connectionState(c).reason"
          >
            {{ c.name }} — {{ c.database }}{{ connectionState(c).disabled ? ' (planned)' : '' }}
          </option>
        </select>
      </label>

      <span class="arrow" aria-hidden="true">→</span>

      <label class="field">
        <span class="mv-label">Destination</span>
        <select v-model="targetId">
          <option value="" disabled>Choose a connection</option>
          <option
            v-for="c in connections"
            :key="c.id"
            :value="c.id"
            :disabled="connectionState(c).disabled"
            :title="connectionState(c).reason"
          >
            {{ c.name }} — {{ c.database }}{{ connectionState(c).disabled ? ' (planned)' : '' }}
          </option>
        </select>
      </label>
    </div>

    <p v-if="sourceEngine && targetEngine" class="route">
      <PairChip :source="sourceEngine" :target="targetEngine" :planned="!routeAvailability.ok" />
      <span v-if="!routeAvailability.ok" class="reason warn">{{ routeAvailability.reason }}</span>
      <span v-else class="reason ok">Supported</span>
    </p>

    <fieldset v-if="offerMode" class="modes">
      <legend class="mv-label">Mode</legend>

      <label class="mode" :class="{ off: !fullAvailability.ok }">
        <input v-model="mode" type="radio" value="full" :disabled="!fullAvailability.ok">
        <span>
          <strong>Full</strong>
          <em>Schema and data, table by table.</em>
        </span>
      </label>

      <label class="mode" :class="{ off: !queryAvailability.ok }">
        <input v-model="mode" type="radio" value="query" :disabled="!queryAvailability.ok">
        <span>
          <strong>Query</strong>
          <em v-if="queryAvailability.ok">One SQL result into one new table.</em>
          <!-- The reason, always. A disabled radio with no explanation is the
               thing this component exists to avoid. -->
          <em v-else class="warn">{{ queryAvailability.reason }}</em>
        </span>
      </label>
    </fieldset>
  </div>
</template>

<style scoped>
.selector { display: flex; flex-direction: column; gap: var(--mv-s-3); }

.ends { display: flex; align-items: flex-end; gap: var(--mv-s-4); flex-wrap: wrap; }
.field { display: flex; flex-direction: column; gap: var(--mv-s-1); min-width: 220px; flex: 1; }
.field select {
  padding: 6px var(--mv-s-3);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  background: var(--mv-bg-raised); color: var(--mv-fg);
  font-family: inherit; font-size: var(--mv-fs-sm);
}
.field select:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 1px; }
.arrow { color: var(--mv-fg-subtle); padding-bottom: 8px; }

.route { display: flex; align-items: center; gap: var(--mv-s-3); flex-wrap: wrap; }
.reason { font-size: var(--mv-fs-xs); }
.reason.ok { color: var(--mv-ok); }
.reason.warn, .warn { color: var(--mv-warn); }

.modes {
  display: flex; gap: var(--mv-s-4); flex-wrap: wrap;
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-md);
  padding: var(--mv-s-3); margin: 0;
}
.modes legend { padding: 0 var(--mv-s-2); }
.mode { display: flex; align-items: flex-start; gap: var(--mv-s-2); flex: 1; min-width: 240px; }
.mode strong { display: block; font-size: var(--mv-fs-sm); font-weight: var(--mv-fw-medium); }
.mode em {
  display: block; font-style: normal;
  font-size: var(--mv-fs-micro); color: var(--mv-fg-subtle);
  line-height: var(--mv-lh-body); max-width: 46ch;
}
/* Dimmed, but the reason stays at full contrast — on a disabled control it is
   the only thing anyone needs to read. */
.mode.off strong { color: var(--mv-fg-subtle); }

@media (max-width: 720px) {
  .ends { flex-direction: column; align-items: stretch; }
  .arrow { display: none; }
}
</style>
