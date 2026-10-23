import pg from 'pg';

export interface PgListenerOptions {
  readonly connectionString: string;
  readonly channels: readonly string[];
  readonly onNotification: (channel: string, payload: string) => void;
  /** After every (re)connect: notifications sent while disconnected are gone. */
  readonly onConnected?: () => void;
  readonly onError?: (err: Error) => void;
  readonly maxBackoffMs?: number;
}

/**
 * One dedicated connection, outside the pool, holding LISTEN.
 *
 * Not a pooled connection: LISTEN is session state, and a pool hands the
 * session to whoever asks next. When it drops — a meta-db restart, a network
 * blip — it reconnects with backoff and reports `onConnected`, which is the
 * caller's cue to read past its cursors, because NOTIFY has no replay.
 */
export class PgListener {
  private client: pg.Client | null = null;
  private stopped = false;
  private backoffMs = 1_000;
  private retry: NodeJS.Timeout | null = null;
  /** A dropped client emits both `error` and `end`; only the first may schedule a reconnect. */
  private readonly dead = new WeakSet<pg.Client>();

  constructor(private readonly options: PgListenerOptions) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.options.connectionString });
    client.on('notification', (msg) => {
      if (msg.payload !== undefined) this.options.onNotification(msg.channel, msg.payload);
    });
    client.on('error', (err) => this.lost(client, err));
    client.on('end', () => this.lost(client, new Error('LISTEN connection ended')));

    try {
      await client.connect();
      for (const channel of this.options.channels) {
        // Channel names are this codebase's constants, never input; quoted anyway.
        await client.query(`LISTEN "${channel.replace(/"/g, '""')}"`);
      }
    } catch (err) {
      this.lost(client, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.client = client;
    this.backoffMs = 1_000;
    this.options.onConnected?.();
  }

  private lost(client: pg.Client, err: Error): void {
    if (this.dead.has(client)) return;
    this.dead.add(client);
    if (this.client === client) this.client = null;
    client.removeAllListeners();
    // A late 'error' on an emitter with no listener throws, which would take
    // the whole web process down over a connection it already gave up on.
    client.on('error', () => undefined);
    void client.end().catch(() => undefined);
    if (this.stopped) return;
    this.options.onError?.(err);
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? 30_000);
    this.retry = setTimeout(() => void this.connect(), wait);
    this.retry.unref?.();
  }
}
