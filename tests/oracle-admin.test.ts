import { afterEach, expect, spyOn, test } from "bun:test";
import { OracleService } from "../oracle-service.ts";
import { captureConsole, createRestorer, setArgv } from "./helpers/cli.ts";

const GAME = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";
const restorer = createRestorer();
afterEach(() => restorer.restoreAll());

test("disables auto-complete for a game and closes the oracle", async () => {
  setArgv(restorer, "scripts/oracle-admin.ts", ["auto-complete", GAME, "off"]);
  const output = captureConsole(restorer);
  const toggles: Array<[string, boolean]> = [];
  let closed = 0;
  restorer.track(
    spyOn(OracleService, "getInstance").mockResolvedValue({
      setAutoCompleteDisabled: (gameAddress: string, disabled: boolean) => {
        toggles.push([gameAddress, disabled]);
        return { success: true, autoCompleteDisabled: disabled };
      },
      close: async () => {
        closed += 1;
      },
    } as never),
  );

  await import("../scripts/oracle-admin.ts");

  expect(toggles).toEqual([[GAME, true]]);
  expect(output.log).toEqual([`Auto-complete disabled for ${GAME}`]);
  expect(closed).toBe(1);
});
