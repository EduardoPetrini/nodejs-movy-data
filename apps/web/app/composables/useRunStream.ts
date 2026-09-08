import type { ServerFrame, WireEvent } from '#shared/run-wire'
import { applyFrame, applyEvents, emptyRunState, runIsOver } from '../utils/run-reducer'
import type { RunState } from '../utils/run-reducer'

export type StreamStatus = 'connecting' | 'live' | 'catching-up' | 'closed' | 'revoked' | 'failed'

/**
 * Watches one run.
 *
 * The socket is a fast path over a durable record, not the record itself. So
 * every failure here degrades to "ask the REST endpoint for everything after
 * `lastSeq`" rather than to a broken page — the same cursor the socket would
 * have used, which is why the two agree on what "missed" means.
 */
export function useRunStream(orgSlug: string, runId: string) {
  const state = shallowRef<RunState>(emptyRunState())
  const status = ref<StreamStatus>('connecting')
  const detail = ref<string | null>(null)

  let socket: WebSocket | null = null
  let attempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  async function mintTicket(): Promise<string> {
    const { ticket } = await $fetch<{ ticket: string }>(
      `/api/orgs/${orgSlug}/runs/${runId}/ticket`,
      { method: 'POST' }
    )
    return ticket
  }

  /**
   * The fallback, and the reconnect catch-up.
   *
   * Pages until it stops receiving a full batch, so a long gap is closed
   * completely rather than to the first 500 events.
   */
  async function catchUp(): Promise<void> {
    status.value = 'catching-up'
    for (let page = 0; page < 50; page += 1) {
      const res = await $fetch<{ events: WireEvent[] }>(
        `/api/orgs/${orgSlug}/runs/${runId}/events`,
        { query: { afterSeq: state.value.lastSeq, limit: 500 } }
      )
      if (res.events.length === 0) return
      state.value = applyEvents(state.value, res.events)
      if (res.events.length < 500) return
    }
  }

  function scheduleReconnect(): void {
    if (stopped || runIsOver(state.value)) return
    attempts += 1
    // Backs off to 15s. A migration can take an hour; a tab reconnecting every
    // second for that long is a denial of service against our own server.
    const delay = Math.min(15_000, 500 * 2 ** Math.min(attempts, 5))
    reconnectTimer = setTimeout(() => void connect(), delay)
  }

  async function connect(): Promise<void> {
    if (stopped) return
    status.value = state.value.run ? 'catching-up' : 'connecting'

    let ticket: string
    try {
      ticket = await mintTicket()
    } catch (err) {
      // 403 or 404 is an answer, not a blip: stop rather than hammer.
      const code = (err as { statusCode?: number }).statusCode
      if (code === 403 || code === 404) {
        status.value = 'revoked'
        detail.value = 'You no longer have access to this run.'
        return
      }
      status.value = 'failed'
      detail.value = 'Could not reach the server.'
      scheduleReconnect()
      return
    }

    const url = new URL(`/_ws/runs`, window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url)
    socket = ws

    ws.onopen = () => ws.send(JSON.stringify({ k: 'subscribe', ticket }))

    ws.onmessage = (message) => {
      let frame: ServerFrame
      try {
        frame = JSON.parse(String(message.data)) as ServerFrame
      } catch {
        return
      }

      if (frame.k === 'error') {
        status.value = 'failed'
        detail.value = frame.message
        return
      }
      if (frame.k === 'revoked') {
        status.value = 'revoked'
        detail.value = 'Your access to this organisation was removed.'
        stopped = true
        return
      }

      if (frame.k === 'snapshot') {
        attempts = 0
        state.value = applyFrame(state.value, frame)
        // The snapshot caps at 500 events, so a run further along than that
        // still has a gap to close before this client is genuinely live.
        void catchUp().then(() => { if (!stopped) status.value = 'live' })
        return
      }

      state.value = applyFrame(state.value, frame)
      if (status.value !== 'live' && status.value !== 'catching-up') status.value = 'live'
    }

    ws.onclose = () => {
      if (stopped) return
      if (runIsOver(state.value)) { status.value = 'closed'; return }
      status.value = 'failed'
      detail.value = 'Connection lost. Reconnecting…'
      scheduleReconnect()
    }

    ws.onerror = () => { try { ws.close() } catch { /* already gone */ } }
  }

  function stop(): void {
    stopped = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    try { socket?.close() } catch { /* already gone */ }
    socket = null
  }

  onMounted(() => { void connect() })
  onBeforeUnmount(stop)

  return { state, status, detail, stop, retry: () => { stopped = false; attempts = 0; void connect() } }
}
