const METHODS_TO_WRAP = ["log", "info", "warn", "error", "debug", "trace"] as const;

let loggingInitialized = false;

function formatTimestamp(): string {
  return new Date().toISOString();
}

export function installTimestampLogger(): void {
  if (loggingInitialized) return;
  loggingInitialized = true;

  for (const method of METHODS_TO_WRAP) {
    const original = (console[method] as (...args: any[]) => void).bind(console);

    console[method] = (...args: any[]): void => {
      original(`[${formatTimestamp()}]`, ...args);
    };
  }
}

installTimestampLogger();
