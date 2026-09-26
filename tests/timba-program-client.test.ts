import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import * as contractClient from "@timbagame/protocol/contracts/client";
import * as solanaKit from "../solana-kit.ts";
import { TimbaProgramClient } from "../timba-program-client.ts";
import { logger } from "../logger.ts";
import type { OracleRpc } from "../solana-kit.ts";
import {
  gameClosedEvent,
  gameCompletedEvent,
  gameInitializedEvent,
  operatorGameClosedEvent,
  playerJoinedEvent,
  playerUnjoinedEvent,
  programLogs,
} from "./helpers/program-events.ts";

type Notification = {
  context: { slot: bigint };
  value: { err: unknown | null; logs: readonly string[]; signature: string };
};

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

function track<T extends { mockRestore: () => void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

/** A controllable log stream that ends when the subscription is aborted. */
class LogStream implements AsyncIterable<Notification> {
  private readonly queue: Notification[] = [];
  private waiting: ((result: IteratorResult<Notification>) => void) | null = null;
  private failure: Error | null = null;
  private done = false;

  constructor(signal: AbortSignal) {
    signal.addEventListener("abort", () => this.end(), { once: true });
  }

  push(notification: Notification): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: notification, done: false });
    } else this.queue.push(notification);
  }

  end(): void {
    this.done = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  fail(error: Error): void {
    this.failure = error;
    this.end();
  }

  [Symbol.asyncIterator](): AsyncIterator<Notification> {
    return {
      next: () => {
        const next = this.queue.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = (result) =>
            this.failure ? resolve(Promise.reject(this.failure) as never) : resolve(result);
        });
      },
    };
  }
}

function fakeSubscriptions() {
  const streams: LogStream[] = [];
  const endpoints: string[] = [];
  const filters: unknown[] = [];
  let failNext: Error | null = null;
  track(
    spyOn(solanaKit, "createRpcSubscriptions").mockImplementation(((endpoint: string) => {
      endpoints.push(endpoint);
      return {
        logsNotifications: (filter: unknown) => {
          filters.push(filter);
          return {
            subscribe: async ({ abortSignal }: { abortSignal: AbortSignal }) => {
              if (failNext) {
                const error = failNext;
                failNext = null;
                throw error;
              }
              const stream = new LogStream(abortSignal);
              streams.push(stream);
              return stream;
            },
          };
        },
      };
    }) as never),
  );
  return {
    streams,
    endpoints,
    filters,
    failNextSubscribe: (error: Error) => {
      failNext = error;
    },
  };
}

function captureTimers() {
  const scheduled: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  track(
    spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
      const entry = { callback, ms, cleared: false };
      scheduled.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout),
  );
  track(
    spyOn(globalThis, "clearTimeout").mockImplementation(((entry: { cleared: boolean }) => {
      if (entry) entry.cleared = true;
    }) as unknown as typeof clearTimeout),
  );
  return scheduled;
}

async function flush(times = 20): Promise<void> {
  for (let index = 0; index < times; index++) await Promise.resolve();
}

async function newClient(endpoint = "https://rpc.example") {
  const client = new TimbaProgramClient({} as OracleRpc, "0.3.0", () => endpoint);
  return client;
}

async function address(): Promise<Address> {
  return (await generateKeyPairSigner()).address;
}

describe("TimbaProgramClient", () => {
  test("uses the contract IDL address as its program id", async () => {
    const client = await newClient();

    expect(client.programId).toBe(client.idl.address as Address);
  });

  test("fetches game accounts with confirmed commitment", async () => {
    const client = await newClient();
    const game = await address();
    const fetchGame = track(
      spyOn(contractClient, "getContractClient").mockReturnValue({
        fetchGame: async (_rpc: unknown, requested: Address, config: unknown) => ({
          data: { requested, config },
        }),
      } as never),
    );

    await expect(client.fetchGame(game) as Promise<unknown>).resolves.toEqual({
      requested: game,
      config: { commitment: "confirmed" },
    });
    expect(fetchGame).toHaveBeenCalledWith("0.3.0");
  });

  test("dispatches every decoded program event to matching listeners", async () => {
    const subscriptions = fakeSubscriptions();
    const client = await newClient();
    const received: Array<[string, unknown]> = [];
    const events = [
      "gameInitialized",
      "gameCompleted",
      "gameClosed",
      "operatorGameClosed",
      "playerJoined",
      "playerUnjoined",
    ] as const;
    for (const event of events) {
      await client.addEventListener(event, (payload) => {
        received.push([event, (payload as { gameKey: string }).gameKey]);
      });
    }
    const [game, creator, player, mint, operator] = await Promise.all([
      address(),
      address(),
      address(),
      address(),
      address(),
    ]);

    expect(subscriptions.streams).toHaveLength(1);
    expect(subscriptions.endpoints).toEqual(["https://rpc.example"]);
    expect(subscriptions.filters).toEqual([{ mentions: [client.programId] }]);

    const stream = subscriptions.streams[0]!;
    stream.push({
      context: { slot: 5n },
      value: {
        err: { InstructionError: [0, "Custom"] },
        logs: programLogs(client.programId, [gameClosedEvent({ gameKey: game })]),
        signature: "failed",
      },
    });
    stream.push({
      context: { slot: 2n ** 60n },
      value: {
        err: null,
        logs: programLogs(client.programId, [gameClosedEvent({ gameKey: game })]),
        signature: "unsafe-slot",
      },
    });
    stream.push({
      context: { slot: 6n },
      value: {
        err: null,
        logs: programLogs(client.programId, [
          gameInitializedEvent({ gameKey: game, creator, tokenMint: mint }),
          playerJoinedEvent({ gameKey: game, player }),
          playerUnjoinedEvent({ gameKey: game, player }),
          gameCompletedEvent({ gameKey: game, winner: player }),
          gameClosedEvent({ gameKey: game }),
          operatorGameClosedEvent({ gameKey: game, creator, operator }),
        ]),
        signature: "ok",
      },
    });
    await flush();

    expect(received).toEqual([
      ["gameInitialized", game],
      ["gameCompleted", game],
      ["gameClosed", game],
      ["operatorGameClosed", game],
      ["playerJoined", game],
      ["playerUnjoined", game],
    ]);
    await client.close();
  });

  test("prefers the dedicated websocket endpoint when configured", async () => {
    const subscriptions = fakeSubscriptions();
    const previous = process.env["SOLANA_WS_ENDPOINT"];
    process.env["SOLANA_WS_ENDPOINT"] = "wss://ws.example";
    restores.push(() => {
      if (previous === undefined) delete process.env["SOLANA_WS_ENDPOINT"];
      else process.env["SOLANA_WS_ENDPOINT"] = previous;
    });
    const client = await newClient();

    const id = await client.addEventListener("gameCompleted", () => {});
    await client.removeEventListener(id);

    expect(subscriptions.endpoints).toEqual(["wss://ws.example"]);
  });

  test("stops the subscription when the last listener is removed", async () => {
    const subscriptions = fakeSubscriptions();
    const client = await newClient();
    const received: string[] = [];

    const first = await client.addEventListener("gameClosed", () => {
      received.push("first");
    });
    const second = await client.addEventListener("gameClosed", () => {
      received.push("second");
    });
    await client.removeEventListener(first);
    expect(subscriptions.streams).toHaveLength(1);
    await client.removeEventListener(second);

    const game = await address();
    subscriptions.streams[0]!.push({
      context: { slot: 1n },
      value: {
        err: null,
        logs: programLogs(client.programId, [gameClosedEvent({ gameKey: game })]),
        signature: "late",
      },
    });
    await flush();
    expect(received).toEqual([]);
  });

  test("removes the listener when subscribing fails", async () => {
    const subscriptions = fakeSubscriptions();
    const client = await newClient();
    subscriptions.failNextSubscribe(new Error("websocket refused"));
    const warning = track(spyOn(logger, "warning").mockImplementation(() => {}));

    await expect(client.addEventListener("gameClosed", () => {})).rejects.toThrow(
      "websocket refused",
    );
    await flush();

    const retry = await client.addEventListener("gameClosed", () => {});
    expect(subscriptions.streams).toHaveLength(1);
    expect(warning).toHaveBeenCalledWith(
      "Timba program log subscription failed:",
      expect.objectContaining({ message: "websocket refused" }),
    );
    await client.removeEventListener(retry);
  });

  test("reconnects one second after the log stream ends unexpectedly", async () => {
    const subscriptions = fakeSubscriptions();
    const timers = captureTimers();
    const client = await newClient();
    await client.addEventListener("gameClosed", () => {});

    subscriptions.streams[0]!.end();
    await flush();
    const reconnect = timers.filter(({ ms }) => ms === 1_000);
    expect(reconnect).toHaveLength(1);

    reconnect[0]!.callback();
    await flush();

    expect(subscriptions.streams).toHaveLength(2);
    await client.close();
  });

  test("logs stream errors and keeps retrying failed reconnects", async () => {
    const subscriptions = fakeSubscriptions();
    const timers = captureTimers();
    const warning = track(spyOn(logger, "warning").mockImplementation(() => {}));
    const client = await newClient();
    await client.addEventListener("gameClosed", () => {});

    subscriptions.streams[0]!.fail(new Error("socket reset"));
    await flush();
    expect(warning).toHaveBeenCalledWith(
      "Timba program log subscription failed:",
      expect.objectContaining({ message: "socket reset" }),
    );

    subscriptions.failNextSubscribe(new Error("still down"));
    timers.filter(({ ms }) => ms === 1_000)[0]!.callback();
    await flush();

    expect(warning).toHaveBeenCalledWith(
      "Failed to restore Timba program log subscription:",
      expect.objectContaining({ message: "still down" }),
    );
    const retries = timers.filter(({ ms }) => ms === 1_000);
    expect(retries.length).toBeGreaterThanOrEqual(2);

    retries.at(-1)!.callback();
    await flush();
    expect(subscriptions.streams).toHaveLength(2);
    await client.close();
  });

  test("does not reconnect after every listener is gone", async () => {
    const subscriptions = fakeSubscriptions();
    const timers = captureTimers();
    const client = await newClient();
    const id = await client.addEventListener("gameClosed", () => {});

    subscriptions.streams[0]!.end();
    await flush();
    const reconnect = timers.find(({ ms }) => ms === 1_000)!;
    (client as unknown as { listeners: Map<number, unknown> }).listeners.delete(id);
    reconnect.callback();
    await flush();

    expect(subscriptions.streams).toHaveLength(1);
  });
});
