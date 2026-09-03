import { describe, expect, it } from "bun:test";
import {
  contractIdl,
  contractVersion,
  getContractIdl,
  parseContractVersion,
} from "../contract-idl.ts";

describe("contract ABI", () => {
  it("requires the canonical v0.3.0 IDL", () => {
    expect(contractVersion).toBe("0.3.0");
    expect(contractIdl.metadata.version).toBe("0.3.0");
  });

  it("loads both supported contract ABIs", () => {
    expect(getContractIdl("0.2.0").metadata.version).toBe("0.2.0");
    expect(getContractIdl("0.3.0").metadata.version).toBe("0.3.0");
  });

  it("defaults runtime selection to v0.2.0 and rejects unknown versions", () => {
    expect(parseContractVersion(undefined)).toBe("0.2.0");
    expect(parseContractVersion(" 0.3.0 ")).toBe("0.3.0");
    expect(() => parseContractVersion("0.4.0")).toThrow("CONTRACT_VERSION must be one of");
  });

  it("loads the canonical participant layout", () => {
    const game = contractIdl.types.find((value: any) => value.name === "Game") as any;
    expect(game.type.fields.at(-1)).toMatchObject({
      name: "participants",
      type: { vec: "pubkey" },
    });
  });
});
