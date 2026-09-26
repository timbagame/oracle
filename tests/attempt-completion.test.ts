import { afterEach, expect, spyOn, test } from "bun:test";
import { OracleService } from "../oracle-service.ts";
import { captureConsole, createRestorer, setArgv, until } from "./helpers/cli.ts";

const GAME = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";
const restorer = createRestorer();
afterEach(() => restorer.restoreAll());

test("attempts completion of the given game and prints the result", async () => {
  setArgv(restorer, "scripts/attempt-completion.ts", [GAME]);
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

  await import("../scripts/attempt-completion.ts");
  await until(() => stopped === 1);

  expect(requested).toEqual([GAME]);
  expect(output.log.map((line) => JSON.parse(line))).toEqual([
    { result: { success: true, txHash: "tx-1" } },
  ]);
  expect(output.error).toEqual([]);
});
