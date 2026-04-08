import { ILogger } from '../../domain/ports/logger.port';

export class ConsoleLogger implements ILogger {
  private prefix: string;

  constructor(prefix = '') {
    this.prefix = prefix ? `[${prefix}] ` : '';
  }

  private timestamp(): string {
    return new Date().toISOString();
  }

  info(message: string, ...args: unknown[]): void {
    console.log(`${this.timestamp()} INFO  ${this.prefix}${message}`, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(`${this.timestamp()} WARN  ${this.prefix}${message}`, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(`${this.timestamp()} ERROR ${this.prefix}${message}`, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    if (process.env.DEBUG) {
      console.debug(`${this.timestamp()} DEBUG ${this.prefix}${message}`, ...args);
    }
  }
}
