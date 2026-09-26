import { expect, spyOn } from "bun:test";

/**
 * Helpers for testing CLI scripts that run on import. Each script module is loaded once per test
 * process, so every script test drives exactly one invocation.
 */

type Restore = () => void;

export function createRestorer() {
  const restores: Restore[] = [];
  return {
    add(restore: Restore) {
      restores.push(restore);
    },
    track<T extends { mockRestore: () => void }>(spy: T): T {
      restores.push(() => spy.mockRestore());
      return spy;
    },
    restoreAll() {
      while (restores.length > 0) restores.pop()!();
    },
  };
}

export type Restorer = ReturnType<typeof createRestorer>;

/** Runs the script as `bun run <script> ...args` would see its arguments. */
export function setArgv(restorer: Restorer, script: string, args: string[]): void {
  const previous = process.argv;
  process.argv = [previous[0] ?? "bun", script, ...args];
  restorer.add(() => {
    process.argv = previous;
  });
}

export function captureConsole(restorer: Restorer) {
  const output = { log: [] as string[], error: [] as unknown[][] };
  restorer.track(
    spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      output.log.push(values.map(String).join(" "));
    }),
  );
  restorer.track(
    spyOn(console, "error").mockImplementation((...values: unknown[]) => {
      output.error.push(values);
    }),
  );
  return output;
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000 && !condition(); attempt++) await tick();
  expect(condition()).toBe(true);
}

/** Makes `process.exit` throw so a script stops where it would have exited. */
export function exitThrows(restorer: Restorer): Array<number | undefined> {
  const exits: Array<number | undefined> = [];
  restorer.track(
    spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push(code);
      throw new Error(`process.exit(${code})`);
    }) as never),
  );
  return exits;
}
