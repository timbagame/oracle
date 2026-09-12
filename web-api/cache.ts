/** Durable records plus bounded, deduplicated backfills. Failures are never cached. */
export function createVerificationLoader<T>(options: {
  read: (key: string) => string | null;
  write: (key: string, value: string) => void;
  load: (signature: string) => Promise<T>;
  namespace: string;
  concurrency?: number;
}) {
  const pending = new Map<string, Promise<T>>();
  return async (signature: string): Promise<T> => {
    const key = `${options.namespace}:verification-v2:${signature}`;
    const cached = options.read(key);
    if (cached) return JSON.parse(cached) as T;
    const running = pending.get(key);
    if (running) return running;
    if (pending.size >= (options.concurrency ?? 2))
      throw new Error("Verification capacity reached");
    const task = Promise.resolve()
      .then(() => options.load(signature))
      .then((value) => {
        options.write(key, JSON.stringify(value));
        return value;
      });
    pending.set(key, task);
    try {
      return await task;
    } finally {
      pending.delete(key);
    }
  };
}
