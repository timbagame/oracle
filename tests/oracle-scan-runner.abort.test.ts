import { describe, it, expect, spyOn } from "bun:test";
import { createScanRunnerFixture } from "./helpers/scan-runner-fixtures.ts";
import * as delayModule from "../delay.ts";

describe("ScanLoopRunner abort handling", () => {
  it("stops iteration when aborted during inter-game delay", async () => {
    const abortController = new AbortController();

    const { runner, touchCalls, attemptCalls } = createScanRunnerFixture({
      pendingGames: () => [
        { game_address: "game-1", completion_attempts: 0 },
        { game_address: "game-2", completion_attempts: 0 },
      ],
      interGameDelayMs: 50,
      attemptGameCompletion: async () => {
        if (attemptCalls.length === 1) {
          return { success: false, notReady: true };
        }
        return { success: true };
      },
    });

    const delaySpy = spyOn(delayModule, "delay").mockImplementation(async (_ms, options) => {
      expect(options?.signal).toBe(abortController.signal);
      abortController.abort();
    });

    try {
      const stats = await runner.scanAndCompleteActiveGames({
        signal: abortController.signal,
      });

      expect(stats).toEqual({ completed: 0, errors: 0, notReady: 1 });
      expect(attemptCalls).toEqual(["game-1"]);
      expect(touchCalls).toEqual(["game-1"]);
      expect(delaySpy).toHaveBeenCalledTimes(1);
    } finally {
      delaySpy.mockRestore();
    }
  });
});

describe("ScanLoopRunner run-loop waiting", () => {
  it("skips inter-cycle delays when waitForPendingOnly is true and stats report nothing to retry", async () => {
    const { runner } = createScanRunnerFixture({
      pendingGames: () => [],
      interGameDelayMs: 0,
      attemptGameCompletion: async () => ({ success: true }),
    });

    const scanSpy = spyOn(runner, "scanAndCompleteActiveGames").mockResolvedValue({
      completed: 0,
      errors: 0,
      notReady: 0,
    });

    const delaySpy = spyOn(delayModule, "delay").mockImplementation(async () => {});

    try {
      await runner.runScanLoop({
        waitBetweenCyclesMs: 10,
        waitForPendingOnly: true,
        shouldContinue: (_stats: unknown, cycle: number) => cycle < 2,
      });

      expect(scanSpy).toHaveBeenCalledTimes(2);
      expect(delaySpy).not.toHaveBeenCalled();
    } finally {
      scanSpy.mockRestore();
      delaySpy.mockRestore();
    }
  });
});
