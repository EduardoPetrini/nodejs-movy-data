import { describe, it, expect, vi } from 'vitest';
import { startWithRetry } from '../../server/runs/start-with-retry';

describe('startWithRetry', () => {
  it('keeps trying until the meta-db answers, reporting each failure', async () => {
    const start = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(undefined);
    const onRetry = vi.fn();
    const sleep = vi.fn(async () => {});

    const started = await startWithRetry(start, { retryMs: 5_000, isStopped: () => false, onRetry, sleep });

    expect(started).toBe(true);
    expect(start).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ message: 'ECONNREFUSED' }), 5_000);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('gives up once the host is closing, without another attempt', async () => {
    let stopped = false;
    const start = vi.fn(async () => { throw new Error('down'); });
    const sleep = vi.fn(async () => { stopped = true; });

    const started = await startWithRetry(start, { retryMs: 10, isStopped: () => stopped, sleep });

    expect(started).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('never starts on a host that is already closing', async () => {
    const start = vi.fn(async () => {});
    expect(await startWithRetry(start, { retryMs: 10, isStopped: () => true })).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});
