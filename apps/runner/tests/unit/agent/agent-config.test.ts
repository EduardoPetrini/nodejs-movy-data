import { describe, it, expect } from 'vitest';
import { AgentConfigError, DEFAULT_DRAIN_MS, DEFAULT_IDLE_EXIT_MS, readAgentConfig } from '../../../src/agent/agent-config';

const BASE = { MOVY_DATABASE_URL: 'postgres://movy_runner:pw@meta-db:5432/movy_data', MOVY_ENCRYPTION_KEY: 'k' };

describe('readAgentConfig', () => {
  it('defaults to one slot of the default class, named after the host', () => {
    const config = readAgentConfig(BASE, 'runner-default-1');
    expect(config).toMatchObject({
      runnerId: 'runner-default-1',
      runnerClass: 'default',
      slots: 1,
      probeSlots: 2,
      drainMs: DEFAULT_DRAIN_MS,
      provisionedBy: null,
      idleExitMs: DEFAULT_IDLE_EXIT_MS,
      simulationFixture: undefined,
      maxRuns: null,
      healthPort: null,
    });
  });

  it('reads the Job-mode run limit and the opt-in health port', () => {
    expect(readAgentConfig({ ...BASE, MOVY_RUNNER_MAX_RUNS: '1', MOVY_RUNNER_HEALTH_PORT: '8081' }, 'h')).toMatchObject({
      maxRuns: 1, healthPort: 8081,
    });
  });

  it('refuses a run limit or a port that could not be one, rather than run unlimited or unprobed', () => {
    expect(() => readAgentConfig({ ...BASE, MOVY_RUNNER_MAX_RUNS: '0' })).toThrow(/MOVY_RUNNER_MAX_RUNS/);
    expect(() => readAgentConfig({ ...BASE, MOVY_RUNNER_MAX_RUNS: 'one' })).toThrow(/MOVY_RUNNER_MAX_RUNS/);
    expect(() => readAgentConfig({ ...BASE, MOVY_RUNNER_HEALTH_PORT: '0' })).toThrow(/MOVY_RUNNER_HEALTH_PORT/);
    expect(() => readAgentConfig({ ...BASE, MOVY_RUNNER_HEALTH_PORT: '65536' })).toThrow(/MOVY_RUNNER_HEALTH_PORT/);
    expect(() => readAgentConfig({ ...BASE, MOVY_RUNNER_HEALTH_PORT: '80a' })).toThrow(AgentConfigError);
  });

  it('treats an empty run limit and port as unset, as Compose writes them', () => {
    expect(readAgentConfig({ ...BASE, MOVY_RUNNER_MAX_RUNS: '', MOVY_RUNNER_HEALTH_PORT: '' }, 'h')).toMatchObject({
      maxRuns: null, healthPort: null,
    });
  });

  it('reads every variable it documents', () => {
    const config = readAgentConfig({
      ...BASE,
      MOVY_RUNNER_ID: 'r-7', MOVY_RUNNER_CLASS: 'large', MOVY_RUNNER_SLOTS: '3', MOVY_RUNNER_PROBE_SLOTS: '0',
      MOVY_JOURNAL_DIR: '/tmp/j', MOVY_SIMULATION_FIXTURE: '/f.ndjson', MOVY_RUNNER_DRAIN_MS: '5000',
      MOVY_RUNNER_PROVISIONED_BY: 'docker', MOVY_RUNNER_IDLE_EXIT_MS: '60000',
    }, 'host');
    expect(config).toMatchObject({
      runnerId: 'r-7', runnerClass: 'large', slots: 3, probeSlots: 0, journalDir: '/tmp/j',
      simulationFixture: '/f.ndjson', drainMs: 5000, provisionedBy: 'docker', idleExitMs: 60000,
    });
  });

  it("accepts the console's variable names, so one env file can serve both", () => {
    const config = readAgentConfig({ NUXT_DATABASE_URL: 'postgres://x', NUXT_ENCRYPTION_KEY: 'k' }, 'h');
    expect(config.databaseUrl).toBe('postgres://x');
  });

  it('refuses to start without a database or a key, naming the variable', () => {
    expect(() => readAgentConfig({ MOVY_ENCRYPTION_KEY: 'k' })).toThrow(/MOVY_DATABASE_URL/);
    expect(() => readAgentConfig({ MOVY_DATABASE_URL: 'postgres://x' })).toThrow(/MOVY_ENCRYPTION_KEY/);
  });

  it('refuses a bad number instead of quietly using the default', () => {
    expect(() => readAgentConfig({ ...BASE, MOVY_RUNNER_SLOTS: '0' })).toThrow(AgentConfigError);
    expect(() => readAgentConfig({ ...BASE, MOVY_RUNNER_SLOTS: 'two' })).toThrow(/MOVY_RUNNER_SLOTS/);
    expect(() => readAgentConfig({ ...BASE, MOVY_RUNNER_PROBE_SLOTS: '-1' })).toThrow(/MOVY_RUNNER_PROBE_SLOTS/);
  });

  it('treats an empty variable as unset, as Compose writes one', () => {
    expect(readAgentConfig({ ...BASE, MOVY_RUNNER_SLOTS: '', MOVY_RUNNER_PROVISIONED_BY: '' }, 'h')).toMatchObject({
      slots: 1, provisionedBy: null,
    });
  });

  it('refuses a class name that could not be a class', () => {
    expect(() => readAgentConfig({ ...BASE, MOVY_RUNNER_CLASS: 'Large Runner' })).toThrow(/MOVY_RUNNER_CLASS/);
  });

  it('holds a class name to the class file\'s rule, so a bad one fails at boot and not at registration', () => {
    expect(() => readAgentConfig({ ...BASE, MOVY_RUNNER_CLASS: '1x' })).toThrow(/MOVY_RUNNER_CLASS/);
    expect(() => readAgentConfig({ ...BASE, MOVY_RUNNER_CLASS: 'a'.repeat(33) })).toThrow(/MOVY_RUNNER_CLASS/);
    expect(() => readAgentConfig({ ...BASE, MOVY_RUNNER_CLASS: 'web' })).toThrow(/MOVY_RUNNER_CLASS/);
    expect(readAgentConfig({ ...BASE, MOVY_RUNNER_CLASS: 'a'.repeat(32) }).runnerClass).toBe('a'.repeat(32));
  });
});
