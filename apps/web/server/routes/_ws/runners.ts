import type { Peer } from 'crossws';
import { useRunnerHub, useRunnersTicketStore } from '~~/server/runs';
import type { RunnersGrant } from '~~/server/runners/runner-hub';

/**
 * The runner-availability stream. Like `_ws/runs.ts`, it performs NO
 * authorisation: it redeems a ticket an ordinary request already authorised,
 * of its own kind, and hands the grant to the hub.
 */
export default defineWebSocketHandler({
  open(peer) {
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

    const grant = await redeemTicket(frame.ticket);
    if (!grant) return fail(peer, 'ticket is not valid');

    try {
      await useRunnerHub().subscribe(peer, grant);
    } catch (err) {
      useRunnerHub().unsubscribe(peer);
      fail(peer, 'could not load runner availability');
      console.error('[ws] runners snapshot failed:', err instanceof Error ? err.message : err);
    }
  },

  close(peer) {
    useRunnerHub().unsubscribe(peer);
  },

  error(peer, error) {
    console.error('[ws] runners peer error:', error.message);
    useRunnerHub().unsubscribe(peer);
  },
});

/** An unreachable meta-db reads as any other bad ticket; see `_ws/runs.ts`. */
async function redeemTicket(ticket: unknown): Promise<RunnersGrant | null> {
  try {
    return await useRunnersTicketStore().redeem(ticket);
  } catch (err) {
    console.error('[ws] runners ticket redemption failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

function fail(peer: Peer, message: string): void {
  peer.send(JSON.stringify({ k: 'error', message }));
  peer.close();
}
