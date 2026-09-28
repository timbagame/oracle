import { afterEach, expect, spyOn, test } from "bun:test";
import { OracleService } from "../oracle-service.ts";
import { main } from "../scripts/oracle-admin.ts";
import { captureConsole, createRestorer, exitThrows } from "./helpers/cli.ts";

const GAME = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";
const MINT = "So11111111111111111111111111111111111111112";
const USAGE =
  "Usage:\n" +
  "  bun run admin requeue <game-address>\n" +
  "  bun run admin auto-complete <game-address> <on|off>\n" +
  "  bun run admin token-policy list\n" +
  "  bun run admin token-policy set <mint> <on|off>";
const restorer = createRestorer();
afterEach(() => restorer.restoreAll());

/** Runs the admin script with `args`, backed by a fake oracle that records every call. */
function runAdmin(args: string[], oracle: Record<string, unknown> = {}) {
  const output = captureConsole(restorer);
  const exits = exitThrows(restorer);
  const state = { closed: 0 };
  const getInstance = restorer.track(
    spyOn(OracleService, "getInstance").mockResolvedValue({
      ...oracle,
      close: async () => {
        state.closed += 1;
      },
    } as never),
  );
  return { output, exits, state, getInstance, run: () => main(args) };
}

test("disables auto-complete for a game and closes the oracle", async () => {
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

  await main(["auto-complete", GAME, "off"]);

  expect(toggles).toEqual([[GAME, true]]);
  expect(output.log).toEqual([`Auto-complete disabled for ${GAME}`]);
  expect(closed).toBe(1);
});

test("requeues a game", async () => {
  const requeued: string[] = [];
  const admin = runAdmin(["requeue", GAME], {
    requeueGame: (gameAddress: string) => {
      requeued.push(gameAddress);
      return { success: true };
    },
  });

  await admin.run();

  expect(requeued).toEqual([GAME]);
  expect(admin.output.log).toEqual([`Requeued ${GAME}`]);
  expect(admin.state.closed).toBe(1);
});

test("fails with the oracle's reason when a game cannot be requeued", async () => {
  const admin = runAdmin(["requeue", GAME], {
    requeueGame: () => ({ success: false, reason: "game not found" }),
  });

  await expect(admin.run()).rejects.toThrow("Unable to requeue game: game not found");

  expect(admin.output.log).toEqual([]);
  expect(admin.state.closed).toBe(1);
});

test("enables auto-complete for a game", async () => {
  const toggles: Array<[string, boolean]> = [];
  const admin = runAdmin(["auto-complete", GAME, "on"], {
    setAutoCompleteDisabled: (gameAddress: string, disabled: boolean) => {
      toggles.push([gameAddress, disabled]);
      return { success: true, autoCompleteDisabled: disabled };
    },
  });

  await admin.run();

  expect(toggles).toEqual([[GAME, false]]);
  expect(admin.output.log).toEqual([`Auto-complete enabled for ${GAME}`]);
});

test("fails with the oracle's reason when auto-complete cannot be updated", async () => {
  const admin = runAdmin(["auto-complete", GAME, "off"], {
    setAutoCompleteDisabled: () => ({ success: false, reason: "game already completed" }),
  });

  await expect(admin.run()).rejects.toThrow(
    "Unable to update auto-complete: game already completed",
  );
  expect(admin.state.closed).toBe(1);
});

test("lists token policies as JSON", async () => {
  const policies = [{ mint: MINT, enabled: true }];
  const admin = runAdmin(["token-policy", "list"], { getTokenPolicies: async () => policies });

  await admin.run();

  expect(admin.output.log.map((line) => JSON.parse(line))).toEqual([policies]);
  expect(admin.state.closed).toBe(1);
});

test("updates a token policy and prints the stored policy", async () => {
  const updates: Array<[string, boolean]> = [];
  const admin = runAdmin(["token-policy", "set", MINT, "off"], {
    setTokenPolicy: async (mint: string, enabled: boolean) => {
      updates.push([mint, enabled]);
      return { mint, enabled };
    },
  });

  await admin.run();

  expect(updates).toEqual([[MINT, false]]);
  expect(admin.output.log.map((line) => JSON.parse(line))).toEqual([
    { mint: MINT, enabled: false },
  ]);
});

test("prints usage and exits with code 2 before touching the oracle without a command", async () => {
  const admin = runAdmin([]);

  await expect(admin.run()).rejects.toThrow("process.exit(2)");

  expect(admin.exits).toEqual([2]);
  expect(admin.output.error).toEqual([[USAGE]]);
  expect(admin.getInstance).not.toHaveBeenCalled();
});

test.each([
  ["an unknown command", ["rebuild"]],
  ["requeue without a game", ["requeue"]],
  ["auto-complete without a game", ["auto-complete"]],
  ["auto-complete with an invalid value", ["auto-complete", GAME, "maybe"]],
  ["token-policy list with extra arguments", ["token-policy", "list", MINT]],
  ["token-policy set with an invalid value", ["token-policy", "set", MINT, "yes"]],
  ["token-policy set without a mint", ["token-policy", "set"]],
  ["an unknown token-policy action", ["token-policy", "remove", MINT]],
])("prints usage, exits with code 2 and closes the oracle for %s", async (_name, args) => {
  const admin = runAdmin(args, {
    requeueGame: () => {
      throw new Error("must not requeue");
    },
    setAutoCompleteDisabled: () => {
      throw new Error("must not toggle");
    },
    getTokenPolicies: async () => {
      throw new Error("must not list");
    },
    setTokenPolicy: async () => {
      throw new Error("must not update");
    },
  });

  await expect(admin.run()).rejects.toThrow("process.exit(2)");

  expect(admin.exits).toEqual([2]);
  expect(admin.output.error).toEqual([[USAGE]]);
  expect(admin.output.log).toEqual([]);
  expect(admin.state.closed).toBe(1);
});
