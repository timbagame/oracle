import { afterEach, expect, spyOn, test } from "bun:test";
import { OracleService } from "../oracle-service.ts";
import { main } from "../scripts/attempt-completion.ts";
import { captureConsole, createRestorer, exitThrows } from "./helpers/cli.ts";

const GAME = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";
const restorer = createRestorer();
afterEach(() => restorer.restoreAll());

test("attempts completion of the given game and prints the result", async () => {
  const output = captureConsole(restorer);
  const requested: string[] = [];
  let stopped = 0;
  restorer.track(
    spyOn(OracleService, "getInstance").mockResolvedValue({
      completeGameNow: async (gameAddress: string) => {
        requested.push(gameAddress);
        return { success: true, txHash: "tx-1" };
      },
      stopEventListening: async () => {
        stopped += 1;
      },
    } as never),
  );

  await main([GAME]);

  expect(stopped).toBe(1);
  expect(requested).toEqual([GAME]);
  expect(output.log.map((line) => JSON.parse(line))).toEqual([
    { result: { success: true, txHash: "tx-1" } },
  ]);
  expect(output.error).toEqual([]);
});

test("reports completion failures and still stops listening", async () => {
  const output = captureConsole(restorer);
  let stopped = 0;
  restorer.track(
    spyOn(OracleService, "getInstance").mockResolvedValue({
      completeGameNow: async () => {
        throw new Error("rpc down");
      },
      stopEventListening: async () => {
        stopped += 1;
        throw new Error("already stopped");
      },
    } as never),
  );

  await main([GAME]);

  expect(output.error).toEqual([["Failed to attempt completion:", expect.any(Error)]]);
  expect(stopped).toBe(1);
});

test("prints usage and exits without a game address", async () => {
  const output = captureConsole(restorer);
  const exits = exitThrows(restorer);

  await expect(main([])).rejects.toThrow("process.exit(1)");

  expect(exits).toEqual([1]);
  expect(output.error).toEqual([["Usage: bun run scripts/attempt-completion.ts <gameAddress>"]]);
});
