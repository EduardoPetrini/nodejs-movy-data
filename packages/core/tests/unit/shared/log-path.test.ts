import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import { buildLogFilePath, resolveLogDir } from '../../../src/shared/log-path';

const ORIGINAL = process.env.MOVY_LOG_DIR;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MOVY_LOG_DIR;
  else process.env.MOVY_LOG_DIR = ORIGINAL;
});

describe('resolveLogDir', () => {
  it('is always absolute', () => {
    delete process.env.MOVY_LOG_DIR;
    expect(path.isAbsolute(resolveLogDir())).toBe(true);
    expect(path.isAbsolute(resolveLogDir('relative/logs'))).toBe(true);
  });

  it('prefers an explicit directory over the environment', () => {
    process.env.MOVY_LOG_DIR = '/from/env';
    expect(resolveLogDir('/explicit')).toBe('/explicit');
  });

  it('falls back to MOVY_LOG_DIR, then to cwd/logs', () => {
    process.env.MOVY_LOG_DIR = '/from/env';
    expect(resolveLogDir()).toBe('/from/env');

    delete process.env.MOVY_LOG_DIR;
    expect(resolveLogDir()).toBe(path.join(process.cwd(), 'logs'));
  });
});

describe('buildLogFilePath', () => {
  it('names the file movy_<date>_<time>_<src>_to_<dst>.log', () => {
    const file = path.basename(buildLogFilePath('shop', 'shop_staging', '/tmp/x'));
    expect(file).toMatch(/^movy_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_shop_to_shop_staging\.log$/);
  });

  it('sanitises characters that are unsafe in a filename', () => {
    const file = path.basename(buildLogFilePath('a/b:c', 'd e', '/tmp/x'));
    expect(file).toContain('a_b_c_to_d_e');
    expect(file).not.toContain('/');
    expect(file).not.toContain(':');
  });

  it('returns an absolute path, so a server started elsewhere does not scatter logs', () => {
    delete process.env.MOVY_LOG_DIR;
    expect(path.isAbsolute(buildLogFilePath('a', 'b'))).toBe(true);
  });
});
