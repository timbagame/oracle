import { describe, expect, it, mock } from "bun:test";
import { GameCompletionManager } from "../oracle-completion-manager.ts";
import { Keypair, TransactionExpiredBlockheightExceededError } from "./helpers/solana-fixtures.ts";
import type { OracleMetrics } from "../metrics.ts";
import type { TimbaGameAccount } from "../types/timba.ts";

// Mock dependencies
const mockMetrics: OracleMetrics = {
  recordCompletion: () => {},
  recordScanCycle: () => {},
  recordCleanupSweep: () => {},
};

const mockDb = {
  incrementCompletionAttempts: () => {},
  finalizeCompletedGame: () => {},
  getGamePlayers: () => [],
  getSecretKey: () => null,
  markGameCompleted: () => {},
  replaceGamePlayers: () => {},
  markGameDesynced: () => {},
};

describe("GameCompletionManager.executeGameCompletion transaction handling", () => {
  // executeGameCompletion handles tx success + timeout
  it("handles transaction success followed by a timeout error (false negative)", async () => {
    const landedSignature = "1".repeat(64);
    let confirmCalls = 0;
    const connection = {
      getLatestBlockhash: async () => ({
        value: {
          blockhash: "11111111111111111111111111111111",
          lastValidBlockHeight: 1000n,
        },
      }),
      sendTransaction: mock(async () => landedSignature),
      getSignatureStatuses: async () => ({
        value: [{ confirmationStatus: "confirmed", err: null }],
      }),
    } as any;

    const program = {
      programId: Keypair.generate().publicKey.address,
    };

    const manager = new GameCompletionManager({
      contractVersion: "0.3.0",
      db: mockDb as any,
      metrics: mockMetrics,
      getConnection: () => connection as any,
      getProgram: () => program as any,
      operatorKeypair: Keypair.generate(),
      readinessCache: new Map(),
      secretKeyLength: 32,
      noSecretKeyMessage: "missing",
      confirmTransaction: async () => {
        confirmCalls++;
        throw new TransactionExpiredBlockheightExceededError("expired");
      },
    });
    const gameAccount = {
      creator: Keypair.generate().publicKey,
      tokenMint: Keypair.generate().publicKey,
    } as TimbaGameAccount;

    const args = {
      gameAccount,
      winnerAddress: Keypair.generate().publicKey.address,
      randomHashBuffer: Buffer.alloc(32),
      secretKeyBuffer: Buffer.alloc(32),
      winnerIndex: 0,
    };

    const result = await (manager as any).executeGameCompletion(args);

    expect(confirmCalls).toBe(1);
    expect(result).toBe(landedSignature);
    expect(connection.sendTransaction).toHaveBeenCalledTimes(1);
  });
});
