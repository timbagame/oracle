process.env["SOLANA_NETWORK"] = "devnet";

import { describe, it, expect } from "bun:test";
import { ScanLoopRunner } from "../oracle-scan-runner.ts";
import { OracleDatabase } from "../database.ts";

describe("Oracle Robustness - Temporary RPC Failure", () => {
  it("does not prematurely mark games as desynced or delete secrets on fetch failure", async () => {
    // 1. Setup DB with a pending game and its secret
    const db = OracleDatabase.getInstance();

    // Use a truly unique address for this run to avoid pollution
    const uniqueId = Math.random().toString(36).substring(2, 10);
    const gameAddress = `test-game-${uniqueId}`;
    const secretKey = "00".repeat(32);
    const randomHash = "11".repeat(32);

    db.saveSecretKey(gameAddress, secretKey, randomHash);
    db.trackGame(gameAddress);

    // Verify initial state
    expect(db.getSecretKey(gameAddress)).not.toBeNull();
    expect(db.getGameStatus(gameAddress)).toBe("pending");

    // 2. Mock completion service to simulate "missing-context" (e.g. RPC failure)
    const mockCompletion = {
      resolveContextAndReadiness: async () => ({ status: "missing-context" }),
      attemptGameCompletion: async () => null,
      consumeReadiness: () => undefined,
      getBlockchainTime: async () => Math.floor(Date.now() / 1000),
    };

    const runner = new ScanLoopRunner({
      db,
      metrics: { recordScanCycle: () => {}, recordCompletion: () => {} } as any,
      completion: mockCompletion as any,
      interGameDelayMs: 0,
      maxCompletionAttempts: 5,
      cleanupOldRecords: () => {},
    });

    // 3. Run scan multiple times - should stay pending until max attempts
    for (let i = 1; i < 5; i++) {
      await runner.scanAndCompleteActiveGames();
      expect(db.getGameStatus(gameAddress)).toBe("pending");
    }

    // 4. Final scan should mark as desynced (5th attempt)
    await runner.scanAndCompleteActiveGames();
    expect(db.getGameStatus(gameAddress)).toBe("desynced");

    // 5. Cleanup after desync should STILL NOT delete the secret (per our new logic)
    db.cleanupOldRecords(0.000001); // Cutoff 1ms ago
    expect(db.getSecretKey(gameAddress)).not.toBeNull();

    // 6. Cleanup after explicit completion SHOULD delete it
    db.markGameCompleted(gameAddress);
    await new Promise((r) => setTimeout(r, 10)); // Ensure it's old enough for the cutoff
    db.cleanupOldRecords(0.000001);
    expect(db.getSecretKey(gameAddress)).toBeNull();
  });
});
