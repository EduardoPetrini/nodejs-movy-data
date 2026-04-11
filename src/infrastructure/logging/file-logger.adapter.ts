import * as fs from 'fs';
import * as path from 'path';
import { ILogger } from '../../domain/ports/logger.port';

export class FileLogger implements ILogger {
  private stream: fs.WriteStream;

  constructor(filePath: string) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
  }

  private timestamp(): string {
    return new Date().toISOString();
  }

  private formatArgs(args: unknown[]): string {
    if (args.length === 0) return '';
    return ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  }

  private write(level: string, message: string, args: unknown[]): void {
    this.stream.write(`${this.timestamp()} ${level} ${message}${this.formatArgs(args)}\n`);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('INFO ', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('WARN ', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('ERROR', message, args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('DEBUG', message, args);
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
