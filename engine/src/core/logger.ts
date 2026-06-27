import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const COLORS: Record<LogLevel, string> = {
  DEBUG: '\x1b[37m',   // white
  INFO: '\x1b[36m',    // cyan
  WARN: '\x1b[33m',    // yellow
  ERROR: '\x1b[31m',   // red
};
const RESET = '\x1b[0m';

export class Logger {
  private component: string;
  private minLevel: LogLevel;
  private logFilePath: string | null;

  constructor(component: string, minLevel: LogLevel = 'INFO', logDir?: string) {
    this.component = component;
    this.minLevel = minLevel;

    if (logDir) {
      mkdirSync(logDir, { recursive: true });
      this.logFilePath = join(logDir, 'goalforge.log');
    } else {
      this.logFilePath = null;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel];
  }

  private format(level: LogLevel, message: string, meta?: object): string {
    const ts = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${ts}] [${level}] [${this.component}] ${message}${metaStr}`;
  }

  private write(level: LogLevel, message: string, meta?: object): void {
    if (!this.shouldLog(level)) return;

    const line = this.format(level, message, meta);
    const colored = `${COLORS[level]}${line}${RESET}`;

    if (level === 'ERROR') {
      console.error(colored);
    } else {
      console.log(colored);
    }

    if (this.logFilePath) {
      try {
        appendFileSync(this.logFilePath, line + '\n');
      } catch {
        // silently ignore log write errors
      }
    }
  }

  debug(message: string, meta?: object): void {
    this.write('DEBUG', message, meta);
  }

  info(message: string, meta?: object): void {
    this.write('INFO', message, meta);
  }

  warn(message: string, meta?: object): void {
    this.write('WARN', message, meta);
  }

  error(message: string, meta?: object): void {
    this.write('ERROR', message, meta);
  }
}

export function createLogger(component: string, logDir?: string): Logger {
  const level = (process.env.LOG_LEVEL as LogLevel) ?? 'INFO';
  return new Logger(component, level, logDir);
}
