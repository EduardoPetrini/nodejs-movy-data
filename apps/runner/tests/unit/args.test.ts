import { describe, expect, test } from 'vitest';
import { ArgsError, parseRunnerArgs } from '../../src/args';

describe('parseRunnerArgs', () => {
  test('reads a real-run invocation', () => {
    const args = parseRunnerArgs(['--journal', '/tmp/run.ndjson']);

    expect(args.journalPath).toBe('/tmp/run.ndjson');
    expect(args.simulateFixture).toBeNull();
    expect(args.runId).toBeNull();
    expect(args.speed).toBe(1);
    expect(args.help).toBe(false);
  });

  test('reads a simulate invocation', () => {
    const args = parseRunnerArgs([
      '--journal', '/tmp/run.ndjson',
      '--simulate', 'fixtures/pg.ndjson',
      '--run-id', 'abc',
      '--speed', '0.05',
    ]);

    expect(args.simulateFixture).toBe('fixtures/pg.ndjson');
    expect(args.runId).toBe('abc');
    expect(args.speed).toBe(0.05);
  });

  test('accepts --flag=value as well as --flag value', () => {
    const args = parseRunnerArgs(['--journal=/tmp/j.ndjson', '--run-id=r1']);

    expect(args.journalPath).toBe('/tmp/j.ndjson');
    expect(args.runId).toBe('r1');
  });

  test('ignores a bare -- separator, which pnpm forwards verbatim', () => {
    const args = parseRunnerArgs(['--', '--journal', '/tmp/j.ndjson']);

    expect(args.journalPath).toBe('/tmp/j.ndjson');
  });

  test('throws when --journal is missing', () => {
    expect(() => parseRunnerArgs([])).toThrow(ArgsError);
    expect(() => parseRunnerArgs([])).toThrow(/--journal is required/);
  });

  test('throws when a flag is given no value', () => {
    expect(() => parseRunnerArgs(['--journal'])).toThrow(/--journal requires a value/);
  });

  test('does not swallow the next flag as a value', () => {
    expect(() => parseRunnerArgs(['--journal', '--simulate', 'f.ndjson'])).toThrow(
      /--journal requires a value/
    );
  });

  test('requires --run-id when simulating, since there is no spec to take it from', () => {
    expect(() => parseRunnerArgs(['--journal', '/tmp/j', '--simulate', 'f.ndjson'])).toThrow(
      /--run-id is required with --simulate/
    );
  });

  test('rejects --speed without --simulate rather than silently ignoring it', () => {
    expect(() => parseRunnerArgs(['--journal', '/tmp/j', '--speed', '2'])).toThrow(
      /--speed only applies to --simulate/
    );
  });

  test('rejects a non-positive speed', () => {
    const argv = ['--journal', '/tmp/j', '--simulate', 'f', '--run-id', 'r', '--speed', '0'];
    expect(() => parseRunnerArgs(argv)).toThrow(/--speed must be a positive number/);
  });

  test('rejects an unknown option', () => {
    expect(() => parseRunnerArgs(['--journal', '/tmp/j', '--turbo'])).toThrow(
      /unknown option "--turbo"/
    );
  });

  test('--help short-circuits the required-flag checks', () => {
    expect(parseRunnerArgs(['--help']).help).toBe(true);
  });
});
