/**
 * Centralized logging utility for the Oracle service
 * Provides structured logging with consistent formatting and timestamps
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerConfig {
  minLevel?: LogLevel;
  silent?: boolean;
  timestamps?: boolean;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug" | "trace";
const CONSOLE_METHODS: readonly ConsoleMethod[] = ["log", "info", "warn", "error", "debug", "trace"] as const;

class Logger {
  private config: LoggerConfig = { timestamps: true };
  private timestampsInstalled = false;
  private originalMethods: Map<ConsoleMethod, (...args: unknown[]) => void> = new Map();

  constructor() {
    this.installTimestamps();
  }

  public configure(config: LoggerConfig): void {
    const previousTimestamps = this.config.timestamps;
    this.config = { ...this.config, ...config };

    if (previousTimestamps !== this.config.timestamps) {
      if (this.config.timestamps) {
        this.installTimestamps();
      } else {
        this.uninstallTimestamps();
      }
    }
  }

  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  private installTimestamps(): void {
    if (this.timestampsInstalled) return;
    this.timestampsInstalled = true;

    for (const method of CONSOLE_METHODS) {
      const original = (console[method] as (...args: unknown[]) => void).bind(console);
      this.originalMethods.set(method, original);

      console[method] = (...args: unknown[]): void => {
        original(`[${this.formatTimestamp()}]`, ...args);
      };
    }
  }

  private uninstallTimestamps(): void {
    if (!this.timestampsInstalled) return;
    this.timestampsInstalled = false;

    for (const method of CONSOLE_METHODS) {
      const original = this.originalMethods.get(method);
      if (original) {
        console[method] = original;
      }
    }
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
