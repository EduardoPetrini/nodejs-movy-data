import { ILogger } from '../../domain/ports/logger.port';
import { MigrationEventSink } from '../../domain/ports/event-sink.port';
import { LogLevel, MigrationStepId } from '../../domain/types/events.types';

/**
 * An ILogger that emits its lines as `log` events.
 *
 * Composed into the existing TeeLogger, this puts every logger.* call site in
 * the codebase onto the timeline without touching any of them.
 *
 * Note this is an adapter, not the structural event contract: step and table
 * state travel as typed events precisely so a UI never has to parse strings.
 * Log lines are narration alongside that, not a substitute for it.
 */
export class SinkLogger implements ILogger {
  constructor(
    private readonly emit: MigrationEventSink,
    private readonly currentStep: () => MigrationStepId | undefined = () => undefined
  ) {}

  info(message: string, ...args: unknown[]): void {
    this.push('info', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.push('warn', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.push('error', message, args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.push('debug', message, args);
  }

  private push(level: LogLevel, message: string, args: unknown[]): void {
    const suffix = args.length > 0 ? ' ' + args.map(formatArg).join(' ') : '';
    this.emit({ type: 'log', level, message: message + suffix, stepId: this.currentStep() });
  }
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
