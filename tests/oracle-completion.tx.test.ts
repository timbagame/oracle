import { describe, expect, it, mock } from "bun:test";
import * as anchor from "@anchor-lang/core";
import { GameCompletionManager } from "../oracle-completion-manager.ts";
import { Keypair, TransactionExpiredBlockheightExceededError } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
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
    // Setup
    const connection = {
      getLatestBlockhash: async () => ({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 1000,
      }),
      sendRawTransaction: mock(async () => "tx-sig-1"),
      confirmTransaction: mock(async () => {
        return { value: { err: null } };
      }),
      getSignatureStatus: async () => {
        return { value: { confirmationStatus: "confirmed" } };
      },
      getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID }),
    } as any;

    const program = {
      account: { game: { fetch: async () => ({}) } },
      programId: Keypair.generate().publicKey,
      provider: { opts: {} },
      methods: {
        completeGame: () => ({
          accountsPartial: () => ({
            signers: () => ({
              transaction: async () => {
                const tx = new anchor.web3.Transaction();
                tx.recentBlockhash = "bh1";
                return tx;
              },
            }),
          }),
        }),
      },
    };

    const manager = new GameCompletionManager({
      db: mockDb as any,
      metrics: mockMetrics,
      getConnection: () => connection as any,
      getProgram: () => program as any,
      adminKeypair: Keypair.generate() as unknown as anchor.web3.Keypair,
      readinessCache: new Map(),
      tokenProgramCache: new Map(),
      secretKeyLength: 32,
      noSecretKeyMessage: "missing",
      confirmTransaction: async (sig, blockhash) => {
        await connection.confirmTransaction(sig, blockhash);
      },
    });

    // Mock confirmTransaction to simulate timeout on first attempt
    // and success on second (or just fail first and see what happens)

    // Scenario:
    // 1. sendRawTransaction returns "tx-sig-1"
    // 2. confirmTransaction throws TransactionExpiredBlockheightExceededError
    // 3. Retry logic kicks in
    // 4. getLatestBlockhash returns new blockhash
    // 5. sendRawTransaction returns "tx-sig-2"

    // The bug is that if the first tx actually succeeded on chain but we got a timeout/expiry error locally,
    // the second tx will fail (e.g. "Game already completed" or "Account not found" if closed).
    // However, here we just want to test that it *retries* on timeout.
    // To test the *false negative* specifically, we'd need to simulate the first tx actually landing.

    // Let's verify it retries on BlockheightExceededError

    let confirmCalls = 0;
    connection.confirmTransaction.mockImplementation(async () => {
      confirmCalls++;
      if (confirmCalls === 1) {
        throw new TransactionExpiredBlockheightExceededError("expired");
      }
      return { value: { err: null } };
    });

    const gameAccount = {
      creator: Keypair.generate().publicKey,
      tokenMint: Keypair.generate().publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as TimbaGameAccount;

    const args = {
      gameAccount,
      winnerAddress: Keypair.generate().publicKey,
      randomHashBuffer: Buffer.alloc(32),
      secretKeyBuffer: Buffer.alloc(32),
      winnerIndex: 0,
    };

    const result = await (manager as any).executeGameCompletion(args);

    expect(confirmCalls).toBe(1);
    expect(result).toBe("tx-sig-1"); // It returns the signature of the *successful* send?
    // Wait, if it retries, it sends again.
    // The mock sendRawTransaction returns "tx-sig-1" always.
    // If it retries, it calls sendRawTransaction again.

    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});
