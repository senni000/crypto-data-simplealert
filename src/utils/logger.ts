/**
 * Simple logger with log level filtering
 */

import { LogLevel } from '../types/config';

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

class Logger {
  private level: LogLevel = 'info';

  setLevel(level: LogLevel): void {
    this.level = level;
    this.debug(`Log level set to ${level}`);
  }

  getLevel(): LogLevel {
    return this.level;
  }

  error(message: string, error?: unknown): void {
    if (!this.shouldLog('error')) return;
    if (error instanceof Error) {
      console.error(`[ERROR] ${message}`, error);
    } else if (error !== undefined) {
      console.error(`[ERROR] ${message}`, error);
    } else {
      console.error(`[ERROR] ${message}`);
    }
  }

  warn(message: string, details?: unknown): void {
    if (!this.shouldLog('warn')) return;
    if (details !== undefined) {
      console.warn(`[WARN] ${message}`, details);
    } else {
      console.warn(`[WARN] ${message}`);
    }
  }

  info(message: string, details?: unknown): void {
    if (!this.shouldLog('info')) return;
    if (details !== undefined) {
      console.log(`[INFO] ${message}`, details);
    } else {
      console.log(`[INFO] ${message}`);
    }
  }

  debug(message: string, details?: unknown): void {
    if (!this.shouldLog('debug')) return;
    if (details !== undefined) {
      console.debug(`[DEBUG] ${message}`, details);
    } else {
      console.debug(`[DEBUG] ${message}`);
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[this.level];
  }
}

export const logger = new Logger();
