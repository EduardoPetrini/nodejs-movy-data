import type { Peer } from 'crossws';
import { useRunHub, useTicketStore } from '~~/server/runs';
import { loadRunSnapshot } from '~~/server/runs/snapshot';

/**
 * The run event stream.
 *
 * This handler performs NO authorisation. It redeems a ticket that an ordinary
 * HTTP request already authorised, and hands the resulting grant to the hub.
 * There is deliberately no path from anything on this socket to a room name —
 * see `roomKey()` in run-hub.ts and `socket-isolation.test.ts`.
 */
export default defineWebSocketHandler({
  open(peer) {
    // Nothing is sent before a ticket is redeemed, not even an acknowledgement
    // that the run exists.
    peer.send(JSON.stringify({ k: 'hello' }));
  },

  async message(peer, message) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.text());
    } catch {
      return fail(peer, 'malformed message');
    }

    const frame = parsed as { k?: unknown; ticket?: unknown };
    if (frame?.k !== 'subscribe') return fail(peer, 'expected a subscribe message');

    const grant = useTicketStore().redeem(frame.ticket);
    if (!grant) {
      // One message for expired, spent, forged and wrong-org alike: a
      // distinguishable failure would tell a prober which runs exist.
      return fail(peer, 'ticket is not valid');
    }

    const hub = useRunHub();
    // Joined BEFORE the snapshot is read, on purpose. An event landing during
    // the read is then delivered live as well as appearing in the snapshot —
    // a duplicate the client drops by seq, rather than a hole it cannot detect.
    hub.subscribe(peer, grant);

    try {
      const snapshot = await loadRunSnapshot(grant);
      peer.send(JSON.stringify({ k: 'snapshot', ...snapshot }));
    } catch (err) {
      hub.unsubscribe(peer);
      fail(peer, 'could not load the run');
      console.error('[ws] snapshot failed:', err instanceof Error ? err.message : err);
    }
  },

  close(peer) {
    useRunHub().unsubscribe(peer);
  },

  error(peer, error) {
    console.error('[ws] peer error:', error.message);
    useRunHub().unsubscribe(peer);
  },
});

function fail(peer: Peer, message: string): void {
  peer.send(JSON.stringify({ k: 'error', message }));
  peer.close();
}
