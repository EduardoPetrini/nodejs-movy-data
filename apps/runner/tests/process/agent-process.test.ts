import { spawnSync } from 'child_process';
import * as path from 'path';
import { describe, expect, test } from 'vitest';

/**
 * The standalone agent's boot contract, as a process. Its run loop needs a
 * meta-db and is proved in Compose (docs/runner-service-plan.md, phase 6);
 * what a container orchestrator sees on a misconfiguration does not.
 */
const ENTRY = path.resolve(__dirname, '../../src/agent-main.ts');

function boot(env: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', ENTRY], {
    // Only what is given: the developer's own MOVY_* variables must not leak in.
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('movy-runner-agent at boot', () => {
  test('exits 64 naming the missing variable, without starting anything', () => {
    const result = boot({});
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('MOVY_DATABASE_URL');
  });

  test('refuses to start without the encryption key, rather than failing every run it claims', () => {
    const result = boot({ MOVY_DATABASE_URL: 'postgres://movy_runner:pw@127.0.0.1:1/movy_data' });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('MOVY_ENCRYPTION_KEY');
    // The URL carries a password; a refusal must not echo it.
    expect(result.stderr).not.toContain('pw@');
  });
});
