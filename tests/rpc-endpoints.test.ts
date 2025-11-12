import { describe, expect, test } from "bun:test";
import * as anchor from "@coral-xyz/anchor";
import type { ActiveEndpointChange } from "../rpc-endpoints.ts";
import {
  DEFAULT_MAINNET_ENDPOINT,
  RpcEndpointManager,
  parseRpcEndpointList,
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
    expect(
      parseRpcEndpointList("https://rpc-a, https://rpc-b"),
    ).toEqual(["https://rpc-a", "https://rpc-b"]);

    expect(
      parseRpcEndpointList('["https://rpc-a","https://rpc-b"]'),
    ).toEqual(["https://rpc-a", "https://rpc-b"]);
  });

  test("falls back to default when missing", () => {
    expect(
      parseRpcEndpointList(undefined, { fallback: DEFAULT_MAINNET_ENDPOINT }),
    ).toEqual([DEFAULT_MAINNET_ENDPOINT]);
  });
});

describe("RpcEndpointManager", () => {
  test("switches endpoints after a retryable failure", async () => {
    const endpoints = ["https://rpc-a", "https://rpc-b"];
    const connectionFactory = (endpoint: string, commitment: string) =>
      new FakeConnection(endpoint, commitment, endpoint === endpoints[0]) as unknown as anchor.web3.Connection;

    const manager = new RpcEndpointManager(endpoints, {
      connectionFactory,
    });

    const connection = manager.getConnection();
    const blockHeight = await connection.getBlockHeight();

    expect(blockHeight).toBe(123);
    expect(manager.getActiveEndpoint()).toBe("https://rpc-b");
  });

  test("emits endpoint change notifications", async () => {
    const endpoints = ["https://rpc-a", "https://rpc-b"];
    const connectionFactory = (endpoint: string, commitment: string) =>
      new FakeConnection(endpoint, commitment, endpoint === endpoints[0]) as unknown as anchor.web3.Connection;

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
    const connectionFactory = (
      endpoint: string,
      commitment: string,
    ) => new FatalConnection(endpoint, commitment) as unknown as anchor.web3.Connection;

    const manager = new RpcEndpointManager(endpoints, { connectionFactory });

    await expect(manager.getConnection().getBlockHeight()).rejects.toThrow(
      "HTTP 400",
    );
    expect(manager.getActiveEndpoint()).toBe(endpoints[0]!);
  });

  test("normalizes endpoints before deduplication", () => {
    const endpoints = ["https://rpc", "https://rpc/"];
    const connectionFactory = (endpoint: string, commitment: string) =>
      new FakeConnection(endpoint, commitment, false) as unknown as anchor.web3.Connection;

    const manager = new RpcEndpointManager(endpoints, { connectionFactory });

    expect(manager.getAllEndpoints()).toEqual(["https://rpc"]);
  });
});
