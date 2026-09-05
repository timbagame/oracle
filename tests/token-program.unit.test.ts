import { describe, expect, it } from "bun:test";
import { PublicKey } from "./helpers/solana-fixtures.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  deriveAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TokenOwnerOffCurveError,
} from "../token-program.ts";

const WRAPPED_SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

describe("token program compatibility", () => {
  it("derives the canonical associated token address for an on-curve owner", async () => {
    const owner = new PublicKey("11111111111111111111111111111111");

    expect(String(await deriveAssociatedTokenAddress(WRAPPED_SOL_MINT, owner))).toBe(
      "aqxoAhCwpy3oB1BpNw9hL1HdLYLgPpbPjzxDrrQj3Fs",
    );
  });

  it("supports PDA owners only when explicitly allowed", async () => {
    const owner = PublicKey.findProgramAddressSync(
      [Buffer.from("owner")],
      new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
    )[0];

    await expect(deriveAssociatedTokenAddress(WRAPPED_SOL_MINT, owner)).rejects.toThrow(
      TokenOwnerOffCurveError,
    );
    expect(
      String(await deriveAssociatedTokenAddress(WRAPPED_SOL_MINT, owner, true, TOKEN_PROGRAM_ID)),
    ).toBe("5myBF2P55TgTd7QW7hYYGZfcqwXDY4rgtLhRF4fJMytm");
    expect(
      String(
        await deriveAssociatedTokenAddress(WRAPPED_SOL_MINT, owner, true, TOKEN_2022_PROGRAM_ID),
      ),
    ).toBe("3vdGrVDTV7fMTkQhnXgo3ZQPKfp1eqBeWvPAFdXjZGQi");
  });

  it("matches the canonical PDA derivation for both token programs", async () => {
    const owner = new PublicKey("11111111111111111111111111111111");

    for (const tokenProgramId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const expected = PublicKey.findProgramAddressSync(
        [
          owner.toBuffer(),
          new PublicKey(String(tokenProgramId)).toBuffer(),
          WRAPPED_SOL_MINT.toBuffer(),
        ],
        new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
      )[0];

      expect(
        (await deriveAssociatedTokenAddress(WRAPPED_SOL_MINT, owner, false, tokenProgramId)) ===
          expected.address,
      ).toBe(true);
    }
  });

  it("does not silently substitute the legacy program for Token-2022", async () => {
    const owner = new PublicKey("11111111111111111111111111111111");
    const legacy = await deriveAssociatedTokenAddress(WRAPPED_SOL_MINT, owner);
    const token2022 = await deriveAssociatedTokenAddress(
      WRAPPED_SOL_MINT,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    expect(token2022).not.toBe(legacy);
  });
});
