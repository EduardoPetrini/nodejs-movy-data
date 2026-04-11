import { ILogger } from '../../domain/ports/logger.port';

export class TeeLogger implements ILogger {
  constructor(private readonly loggers: ILogger[]) {}

  info(message: string, ...args: unknown[]): void {
    for (const logger of this.loggers) logger.info(message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    for (const logger of this.loggers) logger.warn(message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    for (const logger of this.loggers) logger.error(message, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    for (const logger of this.loggers) logger.debug(message, ...args);
  }
}
