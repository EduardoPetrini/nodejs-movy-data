import { describe, it, expect, vi } from 'vitest';
import { SinkLogger } from '../../../../src/infrastructure/logging/sink-logger.adapter';
import { TeeLogger } from '../../../../src/infrastructure/logging/tee-logger.adapter';
import { MigrationEventInput, MigrationStepId } from '../../../../src/domain/types/events.types';
import { ILogger } from '../../../../src/domain/ports/logger.port';

function collector() {
  const events: MigrationEventInput[] = [];
  return { events, emit: (e: MigrationEventInput) => events.push(e) };
}

describe('SinkLogger', () => {
  it('maps each log level onto a log event', () => {
    const { events, emit } = collector();
    const logger = new SinkLogger(emit);

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(events.map((e) => e.type === 'log' && e.level)).toEqual(['debug', 'info', 'warn', 'error']);
    expect(events.map((e) => e.type === 'log' && e.message)).toEqual(['d', 'i', 'w', 'e']);
  });

  it('stamps the step the orchestrator is currently in', () => {
    const { events, emit } = collector();
    let step: MigrationStepId | undefined = 'migrate_data';
    const logger = new SinkLogger(emit, () => step);

    logger.info('copying');
    step = undefined;
    logger.info('done');

    expect(events[0].type === 'log' && events[0].stepId).toBe('migrate_data');
    expect(events[1].type === 'log' && events[1].stepId).toBeUndefined();
  });

  it('appends extra arguments to the message', () => {
    const { events, emit } = collector();
    new SinkLogger(emit).info('rows:', 42, { table: 'users' });

    expect(events[0].type === 'log' && events[0].message).toBe('rows: 42 {"table":"users"}');
  });

  it('renders an Error argument as its message, not [object Object]', () => {
    const { events, emit } = collector();
    new SinkLogger(emit).error('failed:', new Error('boom'));

    expect(events[0].type === 'log' && events[0].message).toBe('failed: boom');
  });

  it('survives an argument that cannot be serialised', () => {
    const { events, emit } = collector();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => new SinkLogger(emit).info('x', circular)).not.toThrow();
    expect(events).toHaveLength(1);
  });

  it('composes with TeeLogger so existing log call sites reach the stream untouched', () => {
    const { events, emit } = collector();
    const console: ILogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const tee = new TeeLogger([console, new SinkLogger(emit)]);

    tee.info('Validating connections...');

    expect(console.info).toHaveBeenCalledWith('Validating connections...');
    expect(events[0].type === 'log' && events[0].message).toBe('Validating connections...');
  });
});
