import { describe, expect, it } from "bun:test";
import { contractIdl } from "../contract-idl.ts";

describe("contract ABI", () => {
  it("loads the canonical participant layout", () => {
    const game = contractIdl.types.find((value: any) => value.name === "Game") as any;
    expect(game.type.fields.at(-1)).toMatchObject({
      name: "participants",
      type: { vec: "pubkey" },
    });
  });
});
