import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { resolveWorkerPath } from '../../../src/shared/utils';

/**
 * Regression guard for the worker-path bug fixed in the monorepo restructure.
 *
 * The previous implementation looked for '../../dist/infrastructure/migration'
 * and returned it unconditionally when NODE_ENV=production. Under the old
 * `rootDir: "./"` tsc emitted `dist/src/**`, so that directory was never
 * produced and a production run spawned a Worker against a nonexistent path.
 *
 * These tests fail on any future layout change, in CI, in about a millisecond.
 */
describe('resolveWorkerPath', () => {
  const ORIGINAL = process.env.MOVY_WORKER_DIR;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MOVY_WORKER_DIR;
    else process.env.MOVY_WORKER_DIR = ORIGINAL;
  });

  it('resolves the copy worker to a file that actually exists', () => {
    delete process.env.MOVY_WORKER_DIR;
    const resolved = resolveWorkerPath('table-copy.worker.ts');
    expect(fs.existsSync(resolved)).toBe(true);
  });

  it('resolves as a sibling of shared/, so src and dist both work', () => {
    delete process.env.MOVY_WORKER_DIR;
    const resolved = resolveWorkerPath('table-copy.worker.ts');
    expect(path.dirname(resolved).endsWith(path.join('infrastructure', 'migration'))).toBe(true);
  });

  it('still resolves when NODE_ENV is production', () => {
    // The old implementation short-circuited on this flag and returned a path
    // it had never checked for existence.
    delete process.env.MOVY_WORKER_DIR;
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(fs.existsSync(resolveWorkerPath('table-copy.worker.ts'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('honours MOVY_WORKER_DIR for relocated or bundled hosts', () => {
    process.env.MOVY_WORKER_DIR = path.resolve(__dirname, '../../../src/infrastructure/migration');
    expect(resolveWorkerPath('table-copy.worker.ts')).toBe(
      path.join(process.env.MOVY_WORKER_DIR, 'table-copy.worker.ts')
    );
  });

  it('throws naming every path tried rather than returning a bad one', () => {
    process.env.MOVY_WORKER_DIR = '/nonexistent-movy-worker-dir';
    expect(() => resolveWorkerPath('table-copy.worker.ts')).toThrow(/not found\. Looked in:/);
    expect(() => resolveWorkerPath('table-copy.worker.ts')).toThrow(/MOVY_WORKER_DIR/);
  });
});
