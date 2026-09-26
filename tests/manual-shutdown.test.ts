import { afterEach, expect, spyOn, test } from "bun:test";
import { OracleService } from "../oracle-service.ts";
import { captureConsole, createRestorer, setArgv, until } from "./helpers/cli.ts";

const restorer = createRestorer();
afterEach(() => restorer.restoreAll());

type CycleStats = { completed: number; notReady: number; errors: number };

test("drains pending games, cleans every record and prints a summary", async () => {
  setArgv(restorer, "scripts/manual-shutdown.ts", []);
  const output = captureConsole(restorer);
  const calls: string[] = [];
  const cleanupAges: number[] = [];
  restorer.track(
    spyOn(OracleService, "getInstance").mockResolvedValue({
      stopEventListening: async () => {
        calls.push("stop");
      },
      scanRunner: {
        runScanLoop: async (options: {
          waitBetweenCyclesMs: number;
          waitForPendingOnly: boolean;
          onCycleStart: (cycle: number) => void;
          onCycleComplete: (cycle: number, stats: CycleStats) => void;
        }) => {
          calls.push("scan");
          expect(options).toMatchObject({ waitBetweenCyclesMs: 30_000, waitForPendingOnly: true });
          options.onCycleStart(1);
          options.onCycleComplete(1, { completed: 2, notReady: 1, errors: 0 });
          options.onCycleStart(2);
          options.onCycleComplete(2, { completed: 0, notReady: 0, errors: 1 });
          return { totalCompleted: 2, totalErrors: 1 };
        },
      },
      cleanupOldRecords: (hours: number) => {
        cleanupAges.push(hours);
        return { deletedSecrets: 3, deletedGames: 2, deletedPlayers: 5 };
      },
    } as never),
  );

  await import("../scripts/manual-shutdown.ts");
  await until(() => output.log.some((line) => line.includes("Manual shutdown scan complete")));

  expect(calls).toEqual(["stop", "scan"]);
  expect(cleanupAges).toEqual([0]);
  const text = output.log.join("\n");
  expect(text).toContain("Completed: 2, Not Ready: 1, Errors: 0");
  expect(text).toContain("Waiting 30s for remaining games to settle...");
  expect(text).toContain("No actionable games remaining.");
  expect(text).toContain("Deleted secrets: 3, deleted games: 2, deleted players: 5");
  expect(text).toContain("Total completions: 2, total errors: 1");
  expect(output.error).toEqual([]);
});
