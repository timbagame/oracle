/**
 * Centralized logging utility for the Oracle service
 * Provides structured logging with consistent formatting
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerConfig {
  minLevel?: LogLevel;
  silent?: boolean;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private config: LoggerConfig = {};

  public configure(config: LoggerConfig): void {
    this.config = { ...this.config, ...config };
  }

  private shouldLog(level: LogLevel): boolean {
    if (this.config.silent) return false;
    const minLevel = this.config.minLevel ?? "info";
    return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
  }

  public debug(...args: unknown[]): void {
    if (this.shouldLog("debug")) {
      console.log(...args);
    }
  }

  public info(...args: unknown[]): void {
    if (this.shouldLog("info")) {
      console.log(...args);
    }
  }

  public warn(...args: unknown[]): void {
    if (this.shouldLog("warn")) {
      console.warn(...args);
    }
  }

  public error(...args: unknown[]): void {
    if (this.shouldLog("error")) {
      console.error(...args);
    }
  }

  // Convenience methods for common patterns
  public success(...args: unknown[]): void {
    this.info("✅", ...args);
  }

  public failure(...args: unknown[]): void {
    this.error("❌", ...args);
  }

  public warning(...args: unknown[]): void {
    this.warn("⚠️ ", ...args);
  }

  public progress(...args: unknown[]): void {
    this.info("🔄", ...args);
  }
}

export const logger = new Logger();
