import { describe, expect, it, spyOn } from "bun:test";
import type * as anchor from "./helpers/solana-fixtures.ts";
import type { OracleDatabase } from "../database.ts";
import type { Timba } from "../types/contract.ts";
import { OracleEventProcessor, EVENT_HANDLER_CONFIG } from "../oracle-event-processor.ts";
import { createProgramStub } from "./helpers/program-stub.ts";
import { logger } from "../logger.ts";

function createProcessor() {
  return new OracleEventProcessor({
    getProgram: () => createProgramStub() as unknown as anchor.Program<Timba>,
    db: {} as unknown as OracleDatabase,
    tryAutoComplete: async () => {},
    config: EVENT_HANDLER_CONFIG,
  });
}

type MutationRunner = {
  runEventMutation: (
    eventType: string,
    handler: () => void | Promise<void>,
    gameAddress?: string,
  ) => Promise<void>;
  processingQueues: Map<string, Promise<void>>;
};

describe("OracleEventProcessor per-game mutations", () => {
  it("logs an asynchronous handler failure and releases the game queue", async () => {
    const processor = createProcessor() as unknown as MutationRunner;
    const failure = spyOn(logger, "failure").mockImplementation(() => {});
    const error = new Error("write failed");

    try {
      const running = processor.runEventMutation(
        "playerJoined",
        async () => {
          throw error;
        },
        "game-1",
      );
      expect(processor.processingQueues.has("game-1")).toBe(true);
      await running;

      expect(failure).toHaveBeenCalledWith("Error in playerJoined event for game-1:", error);
      expect(processor.processingQueues.has("game-1")).toBe(false);
    } finally {
      failure.mockRestore();
    }
  });
});
