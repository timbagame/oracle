import { describe, expect, test } from "bun:test";
import * as anchor from "./helpers/solana-fixtures.ts";
import type { ActiveEndpointChange } from "../rpc-endpoints.ts";
import {
  DEFAULT_MAINNET_ENDPOINT,
  RPC_RETRY_BASE_DELAY_MS,
  RpcEndpointManager,
  parseRpcEndpointList,
  resolvePrimaryRpcEndpoint,
} from "../rpc-endpoints.ts";

class FakeConnection {
  public constructor(
    public readonly rpcEndpoint: string,
    public readonly commitment: string,
    private readonly shouldFail: boolean,
  ) {}

  public async getBlockHeight(): Promise<number> {
    if (this.shouldFail) {
      const error = new Error("ECONNRESET - simulated failure");
      (error as { code?: string }).code = "ECONNRESET";
      throw error;
    }
    return 123;
  }
}

describe("parseRpcEndpointList", () => {
  test("handles comma-separated and JSON inputs", () => {
    expect(parseRpcEndpointList("https://rpc-a, https://rpc-b")).toEqual([
      "https://rpc-a",
      "https://rpc-b",
    ]);

    expect(parseRpcEndpointList('["https://rpc-a","https://rpc-b"]')).toEqual([
      "https://rpc-a",
      "https://rpc-b",
    ]);
  });

  test("falls back to default when missing", () => {
    expect(parseRpcEndpointList(undefined, { fallback: DEFAULT_MAINNET_ENDPOINT })).toEqual([
      DEFAULT_MAINNET_ENDPOINT,
    ]);
  });
});

describe("RpcEndpointManager", () => {
  test("switches endpoints after a retryable failure", async () => {
    const endpoints = ["https://rpc-a", "https://rpc-b"];
    const connectionFactory = (endpoint: string, commitment: string) =>
      new FakeConnection(
        endpoint,
        commitment,
        endpoint === endpoints[0],
      ) as unknown as anchor.web3.Connection;

    const manager = new RpcEndpointManager(endpoints, {
      connectionFactory,
    });

    const connection = manager.getConnection();
    const blockHeight = await (connection.getBlockHeight() as unknown as Promise<number>);

    expect(blockHeight).toBe(123);
    expect(manager.getActiveEndpoint()).toBe("https://rpc-b");
  });

  test("switches endpoints for Kit pending RPC requests", async () => {
    const endpoints = ["https://rpc-a", "https://rpc-b"];
    const manager = new RpcEndpointManager(endpoints, {
      connectionFactory: (endpoint) => ({
        getBlockHeight: () => ({
          send: async () => {
            if (endpoint === endpoints[0]) {
              const error = new Error("Unable to connect");
              (error as { code?: string }).code = "ConnectionRefused";
              throw error;
            }
            return 321n;
          },
        }),
      }),
    });

    const blockHeight = await manager.getConnection().getBlockHeight().send();

    expect(blockHeight).toBe(321n);
    expect(manager.getActiveEndpoint()).toBe("https://rpc-b");
  });

  test("emits endpoint change notifications", async () => {
    const endpoints = ["https://rpc-a", "https://rpc-b"];
    const connectionFactory = (endpoint: string, commitment: string) =>
      new FakeConnection(
        endpoint,
        commitment,
        endpoint === endpoints[0],
      ) as unknown as anchor.web3.Connection;

    const manager = new RpcEndpointManager(endpoints, {
      connectionFactory,
    });

    const changes: ActiveEndpointChange[] = [];
    manager.onActiveEndpointChange((change) => {
      changes.push({ ...change });
    });

    const connection = manager.getConnection();
    await connection.getBlockHeight();

    expect(changes).toEqual([
      {
        endpoint: "https://rpc-b",
        index: 1,
        previousEndpoint: "https://rpc-a",
        previousIndex: 0,
      },
    ]);
  });

  test("propagates fatal RPC failures without switching endpoints", async () => {
    class FatalConnection {
      public constructor(
        public readonly rpcEndpoint: string,
        public readonly commitment: string,
      ) {}

      public async getBlockHeight(): Promise<number> {
        const error = new Error("HTTP 400");
        (error as { code?: number }).code = 400;
        throw error;
      }
    }

    const endpoints = ["https://rpc-a", "https://rpc-b"];
    const connectionFactory = (endpoint: string, commitment: string) =>
      new FatalConnection(endpoint, commitment) as unknown as anchor.web3.Connection;

    const manager = new RpcEndpointManager(endpoints, { connectionFactory });

    await expect(manager.getConnection().getBlockHeight()).rejects.toThrow("HTTP 400");
    expect(manager.getActiveEndpoint()).toBe(endpoints[0]!);
  });

  test("normalizes endpoints before deduplication", () => {
    const endpoints = ["https://rpc", "https://rpc/"];
    const connectionFactory = (endpoint: string, commitment: string) =>
      new FakeConnection(endpoint, commitment, false) as unknown as anchor.web3.Connection;

    const manager = new RpcEndpointManager(endpoints, { connectionFactory });

    expect(manager.getAllEndpoints()).toEqual(["https://rpc"]);
  });

  test("waits before rotating endpoints on rate limit", async () => {
    const endpoints = ["https://rpc-a", "https://rpc-b"];
    const warnings: string[] = [];
    const delayedMs: number[] = [];
    const originalRandom = Math.random;
    Math.random = () => 0;

    const connectionFactory = (endpoint: string, commitment: string) => {
      if (endpoint === endpoints[0]) {
        return {
          rpcEndpoint: endpoint,
          commitment,
          async getBlockHeight(): Promise<number> {
            const error = new Error("HTTP 429");
            (error as { code?: number }).code = 429;
            throw error;
          },
        } as unknown as anchor.web3.Connection;
      }

      return {
        rpcEndpoint: endpoint,
        commitment,
        async getBlockHeight(): Promise<number> {
          return 456;
        },
      } as unknown as anchor.web3.Connection;
    };

    const manager = new RpcEndpointManager(endpoints, {
      connectionFactory,
      logger: {
        warn: (...args: unknown[]) => warnings.push(args.join(" ")),
      },
      delayFn: (ms) => {
        delayedMs.push(ms);
        return Promise.resolve();
      },
    });

    Math.random = originalRandom;

    const blockHeight = await (manager
      .getConnection()
      .getBlockHeight() as unknown as Promise<number>);

    expect(blockHeight).toBe(456);
    expect(delayedMs).toHaveLength(1);
    expect(delayedMs[0]).toBeGreaterThanOrEqual(RPC_RETRY_BASE_DELAY_MS);
    expect(warnings.some((entry) => entry.includes("rate limited"))).toBe(true);
  });

  test("honors retry-after when rate limited", async () => {
    const endpoints = ["https://rpc-a", "https://rpc-b"];
    const delayedMs: number[] = [];
    const originalRandom = Math.random;
    Math.random = () => 0;

    const connectionFactory = (endpoint: string, commitment: string) => {
      if (endpoint === endpoints[0]) {
        return {
          rpcEndpoint: endpoint,
          commitment,
          async getBlockHeight(): Promise<number> {
            const error = new Error("HTTP 429");
            (error as { code?: number }).code = 429;
            (error as { headers?: Record<string, string> }).headers = {
              "retry-after": "1",
            };
            throw error;
          },
        } as unknown as anchor.web3.Connection;
      }

      return {
        rpcEndpoint: endpoint,
        commitment,
        async getBlockHeight(): Promise<number> {
          return 789;
        },
      } as unknown as anchor.web3.Connection;
    };

    const manager = new RpcEndpointManager(endpoints, {
      connectionFactory,
      delayFn: (ms) => {
        delayedMs.push(ms);
        return Promise.resolve();
      },
    });

    Math.random = originalRandom;

    const blockHeight = await (manager
      .getConnection()
      .getBlockHeight() as unknown as Promise<number>);

    expect(blockHeight).toBe(789);
    expect(delayedMs).toHaveLength(1);
    expect(delayedMs[0]).toBeGreaterThanOrEqual(1000);
  });
});

describe("RpcEndpointManager listeners and primary endpoint", () => {
  test("stops notifying a listener after it unsubscribes", async () => {
    const endpoints = ["https://rpc-a", "https://rpc-b"];
    const manager = new RpcEndpointManager(endpoints, {
      connectionFactory: (endpoint: string, commitment: string) =>
        new FakeConnection(
          endpoint,
          commitment,
          endpoint === endpoints[0],
        ) as unknown as anchor.web3.Connection,
    });
    const changes: string[] = [];
    const unsubscribe = manager.onActiveEndpointChange((change) => {
      changes.push(change.endpoint);
    });

    unsubscribe();
    await manager.getConnection().getBlockHeight();

    expect(manager.getActiveEndpoint()).toBe("https://rpc-b");
    expect(changes).toEqual([]);
  });

  test("resolves the first configured endpoint or the fallback", () => {
    expect(resolvePrimaryRpcEndpoint("https://one, https://two")).toBe("https://one");
    expect(resolvePrimaryRpcEndpoint(undefined, "https://fallback")).toBe("https://fallback");
  });
});
