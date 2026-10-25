export interface StartWithRetryOptions {
  readonly retryMs: number;
  /** Checked before every attempt and after every wait: a closing host stops trying. */
  readonly isStopped: () => boolean;
  readonly onRetry?: (err: Error, retryMs: number) => void;
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs `start` until it succeeds or the host stops; true once it succeeded.
 *
 * The embedded agent's start reads the meta-db, which may still be coming up
 * beside the console. Tried once, a failure there left a console that serves
 * pages but never claims a run or answers a probe until it is restarted.
 */
export async function startWithRetry(start: () => Promise<void>, options: StartWithRetryOptions): Promise<boolean> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  while (!options.isStopped()) {
    try {
      await start();
      return true;
    } catch (err) {
      options.onRetry?.(err instanceof Error ? err : new Error(String(err)), options.retryMs);
      await sleep(options.retryMs);
    }
  }
  return false;
}
