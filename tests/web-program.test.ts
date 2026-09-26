import { describe, expect, test } from "bun:test";
import { getContractClient } from "@timbagame/protocol/contracts/client";
import { PROGRAM_ID, getGameVaultPDA, getOraclePDA } from "../web-api/program.ts";
import { USDC_MINT } from "../web-api/token-utils.ts";

describe("web program PDAs", () => {
  const client = getContractClient("0.3.0");

  test("derives the oracle PDA of the configured program", async () => {
    const [expected] = await client.findOraclePda({ programAddress: PROGRAM_ID });

    await expect(getOraclePDA()).resolves.toBe(expected);
  });

  test("derives the per-mint game vault PDA", async () => {
    const [expected] = await client.findGameVaultPda(
      { tokenMint: USDC_MINT },
      { programAddress: PROGRAM_ID },
    );

    await expect(getGameVaultPDA(USDC_MINT)).resolves.toBe(expected);
  });
});
