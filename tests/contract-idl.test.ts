import { describe, expect, it } from "bun:test";
import { contractIdl, contractVersion } from "../contract-idl.ts";

describe("contract ABI", () => {
  it("requires the canonical v0.3.0 IDL", () => {
    expect(contractVersion).toBe("0.3.0");
    expect(contractIdl.metadata.version).toBe("0.3.0");
  });

  it("loads the canonical participant layout", () => {
    const game = contractIdl.types.find((value: any) => value.name === "Game") as any;
    expect(game.type.fields.at(-1)).toMatchObject({
      name: "participants",
      type: { vec: "pubkey" },
    });
  });
});
