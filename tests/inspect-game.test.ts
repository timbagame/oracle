import { afterEach, expect, spyOn, test } from "bun:test";
import { OracleService } from "../oracle-service.ts";
import { captureConsole, createRestorer, setArgv, until } from "./helpers/cli.ts";

const GAME = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";
const restorer = createRestorer();
afterEach(() => restorer.restoreAll());

test("prints the on-chain game fields and completion readiness", async () => {
  setArgv(restorer, "scripts/inspect-game.ts", [GAME]);
  const output = captureConsole(restorer);
  let stopped = 0;
  restorer.track(
    spyOn(OracleService, "getInstance").mockResolvedValue({
      completionManager: {
        fetchGameAccount: async (address: string) => {
          expect(address).toBe(GAME);
          return {
            ticketsCount: 2n,
            maxTickets: 4n,
            minTickets: 2n,
            lastSlot: 900n,
            timeout: 3_600n,
            createdAt: 1_700_000_000n,
          };
        },
        evaluateGameReadiness: async () => ({ ready: false, reason: "waiting-for-slot" }),
      },
      stopEventListening: async () => {
        stopped += 1;
      },
    } as never),
  );

  await import("../scripts/inspect-game.ts");
  await until(() => stopped === 1);

  expect(output.log.map((line) => JSON.parse(line))).toEqual([
    {
      address: GAME,
      exists: true,
      ticketsCount: 2,
      maxTickets: 4,
      minTickets: 2,
      lastSlot: 900,
      timeout: 3_600,
      createdAt: 1_700_000_000,
      readiness: { ready: false, reason: "waiting-for-slot" },
    },
  ]);
});
