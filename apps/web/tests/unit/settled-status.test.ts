import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SettledStatusFeed, type SettledStatusHub } from '../../server/runs/settled-status';
import { RunHub } from '../../server/runs/run-hub';
import type { WireRunStatus } from '../../shared/run-wire';

function status(id: string, s: WireRunStatus['status']): WireRunStatus {
  return { id, status: s, error: null, startedAt: null, finishedAt: null };
}

function harness(watched: string[], rows: WireRunStatus[]) {
  const published: WireRunStatus[] = [];
  const hub: SettledStatusHub = {
    isWatching: (id) => watched.includes(id),
    watchedRunIds: () => [...watched],
    publishStatus: (run) => published.push(run),
  };
  const loadStatuses = vi.fn(async (ids: readonly string[]) => rows.filter((r) => ids.includes(r.id)));
  const onError = vi.fn();
  return { feed: new SettledStatusFeed({ hub, loadStatuses, onError }), published, loadStatuses, onError };
}

describe('SettledStatusFeed.announce', () => {
  it('pushes the row of a watched run that was settled', async () => {
    const h = harness(['a'], [status('a', 'failed')]);
    await h.feed.announce('a');
    expect(h.published).toEqual([status('a', 'failed')]);
  });

  it('reads nothing for a run nobody on this host watches', async () => {
    const h = harness([], [status('a', 'failed')]);
    await h.feed.announce('a');
    expect(h.loadStatuses).not.toHaveBeenCalled();
  });
});

describe('SettledStatusFeed.resync — the replay NOTIFY does not have', () => {
  it('pushes every watched run that settled while LISTEN was down, in one read', async () => {
    const h = harness(['a', 'b', 'c'], [status('a', 'failed'), status('b', 'running'), status('c', 'cancelled')]);
    await h.feed.resync();
    expect(h.loadStatuses).toHaveBeenCalledTimes(1);
    expect(h.published.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('reads nothing when nobody watches', async () => {
    const h = harness([], []);
    await h.feed.resync();
    expect(h.loadStatuses).not.toHaveBeenCalled();
  });

  it('reports a failed read rather than rejecting into a LISTEN handler', async () => {
    const h = harness(['a'], []);
    h.loadStatuses.mockRejectedValueOnce(new Error('connection reset'));
    await expect(h.feed.resync()).resolves.toBeUndefined();
    expect(h.onError).toHaveBeenCalledOnce();
  });

  it('sees the runs a real hub holds', async () => {
    const hub = new RunHub();
    hub.subscribe({ send: () => {}, close: () => {} } as never, { runId: 'r1', orgId: 'o', userId: 'u', role: 'admin' } as never);
    expect(hub.watchedRunIds()).toEqual(['r1']);
    hub.close();
  });
});

describe('the LISTEN wiring', () => {
  // The reconnect re-read is one line in a Nitro module with no seam for a unit
  // test; losing it is exactly the bug this file exists for, so its shape is asserted.
  const source = readFileSync(join(__dirname, '../../server/runs/index.ts'), 'utf8');
  const onConnected = source.slice(source.indexOf('onConnected:'), source.indexOf('onError:', source.indexOf('onConnected:')));

  it('re-reads settled statuses on every reconnect, as well as events', () => {
    expect(onConnected).toContain('runFeed.resync()');
    expect(onConnected).toContain('useSettledStatusFeed().resync()');
  });

  it('routes movy_run_settled through the same feed', () => {
    expect(source).toMatch(/RUN_SETTLED_CHANNEL[\s\S]{0,200}useSettledStatusFeed\(\)\.announce\(runId\)/);
  });
});
