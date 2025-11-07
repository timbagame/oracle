import { describe, expect, test } from "bun:test";
import type { Connection } from "@solana/web3.js";
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
      new FakeConnection(endpoint, commitment, endpoint === endpoints[0]) as unknown as Connection;

    const manager = new RpcEndpointManager(endpoints, {
      connectionFactory,
    });

    const connection = manager.getConnection();
    const blockHeight = await connection.getBlockHeight();

    expect(blockHeight).toBe(123);
    expect(manager.getActiveEndpoint()).toBe("https://rpc-b");
  });
});
