import { afterEach, expect, spyOn, test } from "bun:test";
import { OracleService } from "../oracle-service.ts";
import { main } from "../scripts/inspect-game.ts";
import { captureConsole, createRestorer, exitThrows } from "./helpers/cli.ts";

const GAME = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";
const restorer = createRestorer();
afterEach(() => restorer.restoreAll());

test("prints the on-chain game fields and completion readiness", async () => {
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

  await main([GAME]);

  expect(stopped).toBe(1);
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

function oracleWith(fetchGameAccount: () => Promise<unknown>) {
  const state = { stopped: 0 };
  restorer.track(
    spyOn(OracleService, "getInstance").mockResolvedValue({
      completionManager: {
        fetchGameAccount,
        evaluateGameReadiness: async () => ({ ready: true }),
      },
      stopEventListening: async () => {
        state.stopped += 1;
        throw new Error("already stopped");
      },
    } as never),
  );
  return state;
}

test("reports a game account that does not exist", async () => {
  const output = captureConsole(restorer);
  const state = oracleWith(async () => null);

  await main([GAME]);

  expect(output.log.map((line) => JSON.parse(line))).toEqual([{ address: GAME, exists: false }]);
  expect(state.stopped).toBe(1);
});

test("reports lookup failures", async () => {
  const output = captureConsole(restorer);
  const state = oracleWith(async () => {
    throw new Error("rpc down");
  });

  await main([GAME]);

  expect(output.error).toEqual([["Failed to inspect game:", expect.any(Error)]]);
  expect(state.stopped).toBe(1);
});

test("prints usage and exits without a game address", async () => {
  const output = captureConsole(restorer);
  const exits = exitThrows(restorer);

  await expect(main([])).rejects.toThrow("process.exit(1)");

  expect(exits).toEqual([1]);
  expect(output.error).toEqual([["Usage: bun run scripts/inspect-game.ts <gameAddress>"]]);
});
