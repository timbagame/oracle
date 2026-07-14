import { describe, expect, it } from "bun:test";
import { createLegacyIdl, resolveContractVersion } from "../contract-idl.ts";

describe("contract ABI compatibility", () => {
  it("defaults to the deployed 0.1.3 ABI", () => {
    expect(resolveContractVersion(undefined)).toBe("0.1.3");
  });

  it("recreates the legacy Game vector and instruction accounts", () => {
    const idl = createLegacyIdl();
    const game = idl.types.find((value: any) => value.name === "Game");
    expect(game.type.fields.at(-1)).toMatchObject({
      name: "participant_hashes",
      type: { vec: "u64" },
    });
    const complete = idl.instructions.find((value: any) => value.name === "complete_game");
    expect(complete.accounts.some((value: any) => value.name === "system_program")).toBe(true);
    expect(complete.accounts.find((value: any) => value.name === "winner").writable).toBe(true);
  });

  it("rejects unknown versions", () => {
    expect(() => resolveContractVersion("latest")).toThrow(
      "TIMBA_CONTRACT_VERSION must be 0.1.3 or 0.2.0",
    );
  });
});
