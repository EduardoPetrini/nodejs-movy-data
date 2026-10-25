import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgListener } from '../../../src/agent/pg-listener';

/**
 * A pg.Client whose connect the test settles by hand. Hoisted with the mock,
 * since pg-listener imports pg before this file's body runs — hence its own
 * few lines of emitter rather than an import.
 */
const { FakeClient } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class FakeClient {
    static made: FakeClient[] = [];
    readonly queries: string[] = [];
    readonly ended = vi.fn(async () => {});
    private listeners = new Map<string, Listener[]>();
    private settle!: { resolve: () => void; reject: (err: Error) => void };

    constructor() {
      FakeClient.made.push(this);
    }

    on(event: string, fn: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.listeners.get(event) ?? []) fn(...args);
    }

    removeAllListeners(): this {
      this.listeners.clear();
      return this;
    }

    connect(): Promise<void> {
      return new Promise((resolve, reject) => { this.settle = { resolve, reject }; });
    }

    async query(sql: string): Promise<void> {
      this.queries.push(sql);
    }

    end(): Promise<void> {
      return this.ended();
    }

    succeed(): void { this.settle.resolve(); }
    fail(err = new Error('ECONNREFUSED')): void { this.settle.reject(err); }
  }
  return { FakeClient };
});

vi.mock('pg', () => ({ default: { Client: FakeClient } }));

function listener(overrides: Partial<ConstructorParameters<typeof PgListener>[0]> = {}) {
  const onConnected = vi.fn();
  const onError = vi.fn();
  const l = new PgListener({
    connectionString: 'postgres://meta',
    channels: ['movy_run_events'],
    onNotification: () => {},
    onConnected,
    onError,
    ...overrides,
  });
  return { l, onConnected, onError };
}

const latest = () => FakeClient.made[FakeClient.made.length - 1]!;

describe('PgListener', () => {
  beforeEach(() => {
    FakeClient.made = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('LISTENs on every channel and reports the connection', async () => {
    const { l, onConnected } = listener({ channels: ['a', 'b'] });
    l.start();
    latest().succeed();
    await vi.advanceTimersByTimeAsync(0);

    expect(latest().queries).toEqual(['LISTEN "a"', 'LISTEN "b"']);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it('reconnects once when a dropped client emits both error and end', async () => {
    const { l } = listener();
    l.start();
    latest().succeed();
    await vi.advanceTimersByTimeAsync(0);

    const first = latest();
    first.emit('error', new Error('reset'));
    first.emit('end');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(FakeClient.made).toHaveLength(2);
  });

  it('reports every reconnect, since notifications sent meanwhile are gone', async () => {
    const { l, onConnected } = listener();
    l.start();
    latest().succeed();
    await vi.advanceTimersByTimeAsync(0);
    latest().emit('end');
    await vi.advanceTimersByTimeAsync(1_000);
    latest().succeed();
    await vi.advanceTimersByTimeAsync(0);

    expect(onConnected).toHaveBeenCalledTimes(2);
  });

  it('doubles its wait on each failed connect, caps it, and resets after a success', async () => {
    const { l } = listener({ maxBackoffMs: 3_000 });
    l.start();
    latest().fail();
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeClient.made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeClient.made).toHaveLength(2);

    latest().fail();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeClient.made).toHaveLength(3);

    latest().fail();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(FakeClient.made).toHaveLength(3); // capped at 3s, not 4s
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeClient.made).toHaveLength(4);

    latest().succeed();
    await vi.advanceTimersByTimeAsync(0);
    latest().emit('end');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeClient.made).toHaveLength(5);
  });

  it('starts nothing new when stopped while waiting to retry', async () => {
    const { l } = listener();
    l.start();
    latest().fail();
    await vi.advanceTimersByTimeAsync(0);
    await l.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeClient.made).toHaveLength(1);
  });

  it('closes a connection that completes after stop, rather than keeping it LISTENing', async () => {
    // A shutdown during a reconnect: nothing would ever close that client, and
    // its open socket keeps the process from exiting.
    const { l, onConnected } = listener();
    l.start();
    const pending = latest();
    await l.stop();
    pending.succeed();
    await vi.advanceTimersByTimeAsync(0);

    expect(pending.queries).toEqual([]);
    expect(pending.ended).toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
  });
});
