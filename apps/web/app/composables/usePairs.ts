import {
  engineAvailability, modeAvailability, pairAvailability, saveAvailability,
  type Availability, type RunMode, type WirePair,
} from '#shared/pair-capability'

/**
 * The Pair matrix, fetched once and shared.
 *
 * `/api/pairs` is a property of the build — the same answer for every user on
 * every request — so a shared key means the definitions form, the new-run
 * screen and anything else asking about capability all read one copy, fetched
 * once, hydrated from the server render.
 *
 * Every predicate here comes from `#shared/pair-capability`, the same module
 * the API uses. Nothing about capability is decided in the browser; the client
 * only asks the questions the server will answer the same way.
 */
export function usePairs() {
  const { data, pending, error } = useFetch<{ pairs: WirePair[] }>('/api/pairs', {
    key: 'pairs',
    // Capability cannot change while the process lives, so re-fetching on
    // every mount would be a request that can only return what we already have.
    getCachedData: (key, nuxtApp) => nuxtApp.payload.data[key] ?? nuxtApp.static.data[key],
  })

  const pairs = computed<WirePair[]>(() => data.value?.pairs ?? [])

  /**
   * Until the matrix has loaded, everything is unavailable with a reason that
   * says so. Defaulting to "available" would flash an enabled Run button that
   * disables itself a moment later — and, worse, would be clickable in that
   * moment.
   */
  const loading = computed(() => pairs.value.length === 0)
  const notLoaded: Availability = { ok: false, reason: 'Checking which migrations are supported…' }

  return {
    pairs,
    pending,
    error,
    forEngine: (engine: string): Availability =>
      loading.value ? notLoaded : engineAvailability(pairs.value, engine),
    forRoute: (source: string | undefined, target: string | undefined): Availability =>
      loading.value ? notLoaded : pairAvailability(pairs.value, source, target),
    forSaving: (source: string | undefined, target: string | undefined, mode: RunMode): Availability =>
      loading.value ? notLoaded : saveAvailability(pairs.value, source, target, mode),
    forLaunching: (source: string | undefined, target: string | undefined, mode: RunMode): Availability =>
      loading.value ? notLoaded : modeAvailability(pairs.value, source, target, mode),
  }
}
