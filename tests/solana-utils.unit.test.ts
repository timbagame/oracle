import { describe, expect, it } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { resolveTokenProgram } from "../solana-utils.ts";

describe("solana-utils.resolveTokenProgram", () => {
  it("returns direct program ids and caches them", async () => {
    const tokenProgramCache = new Map<string, PublicKey>();
    const mint = Keypair.generate().publicKey;
    const connection = {
        getAccountInfo: async () => null,
    } as any;

    const program = await resolveTokenProgram(connection, mint, TOKEN_2022_PROGRAM_ID, tokenProgramCache);
    expect(program.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(tokenProgramCache.get(mint.toBase58())).toEqual(TOKEN_2022_PROGRAM_ID);
  });

  it("queries mint accounts when program id is missing and memoizes the result", async () => {
    let lookups = 0;
    const owner = TOKEN_PROGRAM_ID;
    const connection = {
      getAccountInfo: async (_pubkey: PublicKey) => {
        lookups += 1;
        return { owner };
      },
    } as any;
    const tokenProgramCache = new Map<string, PublicKey>();

    const mint = Keypair.generate().publicKey;
    const program = await resolveTokenProgram(connection, mint, PublicKey.default, tokenProgramCache);
    expect(program.equals(owner)).toBe(true);
    expect(lookups).toBe(1);

    const cached = await resolveTokenProgram(connection, mint, PublicKey.default, tokenProgramCache);
    expect(cached.equals(owner)).toBe(true);
    expect(lookups).toBe(1);
    expect(tokenProgramCache.get(mint.toBase58())).toEqual(owner);
  });

  it("throws when the mint owner is unsupported", async () => {
    const unsupported = Keypair.generate().publicKey;
    const connection = {
      getAccountInfo: async () => ({ owner: unsupported }),
    } as any;

    const mint = Keypair.generate().publicKey;

    await expect(
      resolveTokenProgram(connection, mint)
    ).rejects.toThrow(`Unsupported token program owner ${unsupported.toBase58()}`);
  });
});
