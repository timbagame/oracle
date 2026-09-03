import { describe, expect, it, spyOn } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { PublicIndexer } from "../indexer/service.ts";

function createIndexer(pollIntervalMs: number, eventDebounceMs = 0) {
  return new PublicIndexer(
    {} as never,
    {} as never,
    Keypair.generate().publicKey,
    pollIntervalMs,
    eventDebounceMs,
  );
}

describe("PublicIndexer scheduling", () => {
  it("runs one coalesced catch-up when live events wake it", async () => {
    const indexer = createIndexer(60_000);
    const controller = new AbortController();
    let cycle = 0;
    let firstCycleComplete!: () => void;
    const firstCycle = new Promise<void>((resolve) => {
      firstCycleComplete = resolve;
    });
    const runOnce = spyOn(indexer, "runOnce").mockImplementation(async () => {
      cycle += 1;
      if (cycle === 1) firstCycleComplete();
      if (cycle === 2) controller.abort();
      return { indexed: 0, transactions: 0 };
    });

    const running = indexer.run(controller.signal);
    await firstCycle;
    indexer.requestCatchUp();
    indexer.requestCatchUp();
    await running;

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(runOnce.mock.calls[0]?.[0]).toEqual({ reconcileActiveGames: true });
    expect(runOnce.mock.calls[1]?.[0]).toEqual({ reconcileActiveGames: false });
  });

  it("retains periodic catch-up as a recovery path", async () => {
    const indexer = createIndexer(5);
    const controller = new AbortController();
    let cycle = 0;
    const runOnce = spyOn(indexer, "runOnce").mockImplementation(async () => {
      cycle += 1;
      if (cycle === 2) controller.abort();
      return { indexed: 0, transactions: 0 };
    });

    await indexer.run(controller.signal);

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(runOnce.mock.calls[1]?.[0]).toEqual({ reconcileActiveGames: true });
  });
});
