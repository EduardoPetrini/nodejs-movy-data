import type { RunnersServerFrame, RunnersSnapshot } from '#shared/runner-wire'

export type RunnerStatusState = 'connecting' | 'live' | 'stale' | 'revoked'

/**
 * Runner availability for one org, kept current over `/_ws/runners`.
 *
 * Same shape as useRunStream: a ticket minted by an authorised request, then a
 * socket that decides nothing. On any failure it shows the last snapshot it
 * had, marked stale, fetches one over REST, and reconnects with backoff — the
 * panel is advice about capacity, so a gap in it is never an error page.
 */
export function useRunnerStatus(orgSlug: string) {
  const snapshot = shallowRef<RunnersSnapshot | null>(null)
  const status = ref<RunnerStatusState>('connecting')

  let socket: WebSocket | null = null
  let attempts = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  async function fallback(): Promise<void> {
    try {
      snapshot.value = await $fetch<RunnersSnapshot>(`/api/orgs/${orgSlug}/runners`)
    } catch {
      // keep whatever we had; it is already marked stale
    }
  }

  function scheduleRetry(): void {
    if (stopped) return
    attempts += 1
    retryTimer = setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)))
  }

  async function connect(): Promise<void> {
    if (stopped) return
    let ticket: string
    try {
      ;({ ticket } = await $fetch<{ ticket: string }>(`/api/orgs/${orgSlug}/runners/ticket`, { method: 'POST' }))
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode
      if (code === 403 || code === 404) {
        status.value = 'revoked'
        return
      }
      status.value = 'stale'
      void fallback()
      scheduleRetry()
      return
    }

    const url = new URL('/_ws/runners', window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url)
    socket = ws
    ws.onopen = () => ws.send(JSON.stringify({ k: 'subscribe', ticket }))
    ws.onmessage = (message) => {
      let frame: RunnersServerFrame
      try {
        frame = JSON.parse(String(message.data)) as RunnersServerFrame
      } catch {
        return
      }
      if (frame.k === 'runners') {
        attempts = 0
        const { k: _k, ...rest } = frame
        snapshot.value = rest
        status.value = 'live'
      } else if (frame.k === 'revoked') {
        status.value = 'revoked'
        stopped = true
      }
    }
    ws.onclose = () => {
      if (stopped) return
      status.value = 'stale'
      void fallback()
      scheduleRetry()
    }
    ws.onerror = () => { try { ws.close() } catch { /* already gone */ } }
  }

  function stop(): void {
    stopped = true
    if (retryTimer) clearTimeout(retryTimer)
    try { socket?.close() } catch { /* already gone */ }
    socket = null
  }

  onMounted(() => { void connect() })
  onBeforeUnmount(stop)

  return { snapshot, status }
}
