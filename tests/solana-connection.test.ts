import { describe, it, expect } from "bun:test";
import {
  createSolanaConnection,
  MAINNET_FALLBACK_RPC,
  isConnectionIssue,
  __testing,
} from "../solana-connection.ts";

describe("createSolanaConnection", () => {
  it("falls back to mainnet when the primary RPC is unreachable", async () => {
    const callLog: string[] = [];
    const behaviors: Record<string, () => Promise<number>> = {
      "http://unreachable": async () => {
        const error = new Error("connect ECONNREFUSED");
        (error as NodeJS.ErrnoException).code = "ECONNREFUSED";
        throw error;
      },
      [MAINNET_FALLBACK_RPC]: async () => 123,
    };

    class FakeConnection {
      public readonly rpcEndpoint: string;

      constructor(endpoint: string) {
        this.rpcEndpoint = endpoint;
      }

      async getSlot(): Promise<number> {
        callLog.push(`${this.rpcEndpoint}:getSlot`);
        const behavior = behaviors[this.rpcEndpoint];
        if (!behavior) {
          throw new Error(`No behavior registered for ${this.rpcEndpoint}`);
        }
        return behavior();
      }
    }

    __testing.setConnectionFactory((endpoint) => new FakeConnection(endpoint) as any);
    try {
      const connection = createSolanaConnection("http://unreachable");
      const slot = await connection.getSlot();
      expect(slot).toBe(123);
      expect(callLog).toEqual([
        "http://unreachable:getSlot",
        `${MAINNET_FALLBACK_RPC}:getSlot`,
      ]);
      expect(connection.rpcEndpoint).toBe(MAINNET_FALLBACK_RPC);
    } finally {
      __testing.setConnectionFactory();
    }
  });

  it("preserves the configured RPC when errors are not connection-related", async () => {
    const callLog: string[] = [];
    const behaviors: Record<string, () => Promise<number>> = {
      "http://custom": async () => {
        const error = new Error("Account does not exist");
        throw error;
      },
      [MAINNET_FALLBACK_RPC]: async () => 456,
    };

    class FakeConnection {
      public readonly rpcEndpoint: string;

      constructor(endpoint: string) {
        this.rpcEndpoint = endpoint;
      }

      async getSlot(): Promise<number> {
        callLog.push(`${this.rpcEndpoint}:getSlot`);
        const behavior = behaviors[this.rpcEndpoint];
        if (!behavior) {
          throw new Error(`No behavior registered for ${this.rpcEndpoint}`);
        }
        return behavior();
      }
    }

    __testing.setConnectionFactory((endpoint) => new FakeConnection(endpoint) as any);
    try {
      const connection = createSolanaConnection("http://custom");
      await expect(connection.getSlot()).rejects.toThrow("Account does not exist");
      expect(callLog).toEqual(["http://custom:getSlot"]);
      expect(connection.rpcEndpoint).toBe("http://custom");
    } finally {
      __testing.setConnectionFactory();
    }
  });
});

describe("isConnectionIssue", () => {
  it("detects network error codes and messages", () => {
    const error: NodeJS.ErrnoException = new Error("connect ECONNREFUSED 127.0.0.1");
    error.code = "ECONNREFUSED";
    expect(isConnectionIssue(error)).toBe(true);
    expect(isConnectionIssue(new TypeError("fetch failed"))).toBe(true);
    expect(isConnectionIssue("socket hang up")).toBe(true);
  });

  it("returns false for non-network errors", () => {
    expect(isConnectionIssue(new Error("Account does not exist"))).toBe(false);
    expect(isConnectionIssue("program error")).toBe(false);
  });
});
