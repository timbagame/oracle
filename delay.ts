export const DEFAULT_DELAY_MS = 1000;

interface DelayOptions {
  signal?: AbortSignal;
}

export function delay(ms: number, options: DelayOptions = {}): Promise<void> {
  const { signal } = options;

  if (ms <= 0) {
    return Promise.resolve();
  }

  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    function cleanup() {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
    }

    function handleAbort() {
      cleanup();
      resolve();
    }

    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    if (signal) {
      signal.addEventListener("abort", handleAbort, { once: true });
    }
  });
}
