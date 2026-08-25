import { describe, expect, it } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import {
  deriveAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TokenOwnerOffCurveError,
} from "../token-program.ts";

const WRAPPED_SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

describe("token program compatibility", () => {
  it("derives the canonical associated token address for an on-curve owner", () => {
    const owner = new PublicKey("11111111111111111111111111111111");

    expect(deriveAssociatedTokenAddress(WRAPPED_SOL_MINT, owner).toBase58()).toBe(
      "aqxoAhCwpy3oB1BpNw9hL1HdLYLgPpbPjzxDrrQj3Fs",
    );
  });

  it("supports PDA owners only when explicitly allowed", () => {
    const owner = PublicKey.findProgramAddressSync(
      [Buffer.from("owner")],
      new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
    )[0];

    expect(() => deriveAssociatedTokenAddress(WRAPPED_SOL_MINT, owner)).toThrow(
      TokenOwnerOffCurveError,
    );
    expect(
      deriveAssociatedTokenAddress(WRAPPED_SOL_MINT, owner, true, TOKEN_PROGRAM_ID).toBase58(),
    ).toBe("5myBF2P55TgTd7QW7hYYGZfcqwXDY4rgtLhRF4fJMytm");
    expect(
      deriveAssociatedTokenAddress(WRAPPED_SOL_MINT, owner, true, TOKEN_2022_PROGRAM_ID).toBase58(),
    ).toBe("3vdGrVDTV7fMTkQhnXgo3ZQPKfp1eqBeWvPAFdXjZGQi");
  });
});
