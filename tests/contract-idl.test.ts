import { describe, expect, it } from "bun:test";
import { getContractIdl, resolveContractVersion } from "../contract-idl.ts";

describe("contract ABI compatibility", () => {
  it("accepts both supported versions", () => {
    expect(resolveContractVersion("0.1.3")).toBe("0.1.3");
    expect(resolveContractVersion("0.2.0")).toBe("0.2.0");
  });

  it("loads the exact legacy Game vector and instruction accounts", () => {
    const idl = getContractIdl("0.1.3");
    const game = idl.types.find((value: any) => value.name === "Game");
    expect(game.type.fields.at(-1)).toMatchObject({
      name: "participant_hashes",
      type: { vec: "u64" },
    });
    const complete = idl.instructions.find((value: any) => value.name === "complete_game");
    expect(complete.accounts.some((value: any) => value.name === "system_program")).toBe(true);
    expect(complete.accounts.find((value: any) => value.name === "winner").writable).toBe(true);
    expect(idl.errors.some((value: any) => value.code === 7402)).toBe(true);
  });

  it("loads the 0.2.0 participant layout", () => {
    const idl = getContractIdl("0.2.0");
    const game = idl.types.find((value: any) => value.name === "Game");
    expect(game.type.fields.at(-1)).toMatchObject({
      name: "participants",
      type: { vec: "pubkey" },
    });
  });

  it("rejects unknown versions", () => {
    expect(() => resolveContractVersion("latest")).toThrow(
      "TIMBA_CONTRACT_VERSION must be 0.1.3 or 0.2.0",
    );
  });
});
