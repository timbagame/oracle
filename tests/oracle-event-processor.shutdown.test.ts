import { describe, it, expect } from "bun:test";
import type * as anchor from "@coral-xyz/anchor";
import type { OracleDatabase } from "../database.ts";
import type { Timba } from "../idl/idlType.ts";
import {
  OracleEventProcessor,
  EVENT_HANDLER_CONFIG,
  type OracleEventProcessorOptions,
} from "../oracle-event-processor.ts";
import { createProgramStub } from "./helpers/program-stub.ts";

describe("OracleEventProcessor shutdown", () => {
  it("clears scheduled registry sync retry timers on stopListening", async () => {
    type Timer = ReturnType<typeof setTimeout>;

    const scheduledTimers: Timer[] = [];
    const clearedTimers: Timer[] = [];

    const scheduleRetryTimeout = (((_callback: Parameters<typeof setTimeout>[0], _delay?: number) => {
      const timer = Symbol("timer") as unknown as Timer;
      scheduledTimers.push(timer);
      return timer;
    }) as unknown) as typeof setTimeout;

    const clearRetryTimeout = (((timer?: Parameters<typeof clearTimeout>[0]) => {
      if (timer === undefined) {
        return;
      }
      clearedTimers.push(timer as unknown as Timer);
    }) as unknown) as typeof clearTimeout;

    const programStub = createProgramStub();
    const dbStub = {} as unknown as OracleDatabase;

    const processor = new OracleEventProcessor({
      getProgram: () => programStub as unknown as anchor.Program<Timba>,
      db: dbStub,
      tryAutoComplete: async () => {},
      config: EVENT_HANDLER_CONFIG,
      clearTokenProgramCache: () => {},
      syncPlayerRegistry: async (_options) => false,
      setTimeoutFn: scheduleRetryTimeout,
      clearTimeoutFn: clearRetryTimeout,
      registrySyncRetryDelayMs: 10,
      registrySyncTimeoutMs: 0,
    });

    await processor.startListening();

    type RegistrySyncOptions = Parameters<
      NonNullable<OracleEventProcessorOptions["syncPlayerRegistry"]>
    >[0];

    const scheduler = (
      processor as unknown as {
        registrySyncScheduler?: { schedule: (options: RegistrySyncOptions) => void };
      }
    ).registrySyncScheduler;

    expect(scheduler).toBeDefined();

    scheduler!.schedule({ gameAddress: "game-1", trigger: "test" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(scheduledTimers.length).toBeGreaterThan(0);

    await processor.stopListening();

    for (const timer of scheduledTimers) {
      expect(clearedTimers).toContain(timer);
    }
  });
});
