import { describe, it, expect, vi } from 'vitest';
import { RunEventFeed, type RunEventFeedDeps } from '../../server/runs/run-event-feed';
import type { WireEvent } from '../../shared/run-wire';

const RUN = '11111111-1111-1111-1111-111111111111';

function ev(seq: number): WireEvent {
  return { seq, type: 'table_progress', at: new Date(0).toISOString(), level: null, payload: { seq } };
}

/**
 * A run_events table in memory, plus the hub as a list of what was published.
 * `readAfter` resolves on the next tick, so overlapping notifications really
 * overlap.
 */
function harness(opts: { stored?: number; watched?: boolean; pageSize?: number } = {}) {
  let stored = opts.stored ?? 0;
  let watched = opts.watched ?? true;
  const published: number[][] = [];
  const reads: { runId: string; afterSeq: number }[] = [];
  const deps: RunEventFeedDeps = {
    currentSeq: vi.fn(async () => stored),
    readAfter: vi.fn(async (runId: string, afterSeq: number, limit: number) => {
      reads.push({ runId, afterSeq });
      await new Promise((r) => setTimeout(r, 1));
      const out: WireEvent[] = [];
      for (let s = afterSeq + 1; s <= stored && out.length < limit; s += 1) out.push(ev(s));
      return out;
    }),
    publish: (runId, events) => published.push(events.map((e) => e.seq)),
    isWatched: () => watched,
  };
  const feed = new RunEventFeed(deps, { pageSize: opts.pageSize ?? 500 });
  return {
    feed, deps, published, reads,
    store: (n: number) => { stored = n; },
    unwatch: () => { watched = false; },
  };
}

describe('RunEventFeed', () => {
  it('starts a run\'s cursor at what is already stored, so the snapshot covers the past', async () => {
    // track() runs BEFORE the snapshot is read: anything stored after it is
    // delivered live, and an overlap is a duplicate the client drops by seq.
    const h = harness({ stored: 40 });
    await h.feed.track(RUN);
    h.store(42);
    h.feed.notify(RUN, 42);
    await h.feed.idle();

    expect(h.published).toEqual([[41, 42]]);
  });

  it('reads past the cursor on each notification and never re-sends a seq', async () => {
    const h = harness({ stored: 0 });
    await h.feed.track(RUN);
    h.store(3);
    h.feed.notify(RUN, 3);
    await h.feed.idle();
    h.store(5);
    h.feed.notify(RUN, 5);
    await h.feed.idle();

    expect(h.published).toEqual([[1, 2, 3], [4, 5]]);
  });

  it('folds notifications that arrive during a read into one more read, not a parallel one', async () => {
    const h = harness({ stored: 0 });
    await h.feed.track(RUN);
    h.store(2);
    h.feed.notify(RUN, 1);
    h.feed.notify(RUN, 2);
    h.store(4);
    h.feed.notify(RUN, 4);
    await h.feed.idle();

    expect(h.published.flat()).toEqual([1, 2, 3, 4]);
    // Never two reads from the same cursor at once.
    const cursors = h.reads.map((r) => r.afterSeq);
    expect(new Set(cursors).size).toBe(cursors.length);
  });

  it('pages through a large gap rather than reading it in one query', async () => {
    const h = harness({ stored: 0, pageSize: 2 });
    await h.feed.track(RUN);
    h.store(5);
    h.feed.notify(RUN, 5);
    await h.feed.idle();

    expect(h.published).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('ignores a notification it is already past, which a second web replica can cause', async () => {
    const h = harness({ stored: 10 });
    await h.feed.track(RUN);
    h.feed.notify(RUN, 10);
    await h.feed.idle();
    expect(h.deps.readAfter).not.toHaveBeenCalled();
  });

  it('ignores a run nobody here is watching, and forgets its cursor', async () => {
    const h = harness({ stored: 0 });
    await h.feed.track(RUN);
    h.unwatch();
    h.store(3);
    h.feed.notify(RUN, 3);
    await h.feed.idle();

    expect(h.deps.readAfter).not.toHaveBeenCalled();
    expect(h.feed.tracked()).toEqual([]);
  });

  it('ignores a notification for a run it never tracked', async () => {
    const h = harness({ stored: 3 });
    h.feed.notify(RUN, 3);
    await h.feed.idle();
    expect(h.deps.readAfter).not.toHaveBeenCalled();
  });

  it('keeps the first cursor when a second peer joins the same run', async () => {
    const h = harness({ stored: 5 });
    await h.feed.track(RUN);
    h.store(8);
    await h.feed.track(RUN);
    h.feed.notify(RUN, 8);
    await h.feed.idle();
    // Moving the cursor to 8 would skip 6-8 for the first peer.
    expect(h.published).toEqual([[6, 7, 8]]);
  });

  it('catches every tracked run up after the LISTEN connection comes back', async () => {
    // Notifications sent while the listener was disconnected are gone for
    // good; reading past each cursor is what turns that into no gap.
    const h = harness({ stored: 2 });
    await h.feed.track(RUN);
    h.store(6);
    h.feed.resync();
    await h.feed.idle();
    expect(h.published).toEqual([[3, 4, 5, 6]]);
  });

  it('survives a failed read and tries again on the next notification', async () => {
    const h = harness({ stored: 0 });
    const onError = vi.fn();
    const feed = new RunEventFeed({ ...h.deps, readAfter: vi.fn().mockRejectedValueOnce(new Error('reset')).mockImplementation(h.deps.readAfter) }, { onError });
    await feed.track(RUN);
    h.store(2);
    feed.notify(RUN, 2);
    await feed.idle();
    expect(onError).toHaveBeenCalled();

    feed.notify(RUN, 2);
    await feed.idle();
    expect(h.published.flat()).toEqual([1, 2]);
  });
});
