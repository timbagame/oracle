import { describe, expect, test } from "bun:test";
import { AccountRole, address } from "@solana/kit";
import { getGameTokenPDA, getGameVaultPDA, PROGRAM_ID } from "../web-api/program.ts";
import { TIMBA_MINT } from "../web-api/token-utils.ts";
import { buildCreateGamePlan } from "../web-api/create-game.ts";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "../web-api/token-program.ts";

const common = {
  creator: address("HGBiGfyR9GF36J4SMPjxsRkFuwYNuNYuzdCjgR4aw4FC"),
  tokenMint: TIMBA_MINT,
  type: "coinflip" as const,
  amount: 1_000_000n,
  minPlayers: 2,
  maxPlayers: 4,
  timeoutSeconds: 1_800n,
  randomHash: Buffer.alloc(32, 7),
  oracleOperator: address("4oRdwjBqMGjhh5octi4BLvtNGCgWdJDMv3bBr9Jpi5V8"),
};

describe("create game plans", () => {
  test("uses the v0.3 oracle operator and shared vault", async () => {
    const plan = await buildCreateGamePlan(common, "0.3.0");
    const initialize = plan.instructions[2]!;
    const gameVault = await getGameVaultPDA(common.tokenMint);
    const vaultTokenAccount = await getAssociatedTokenAddress(
      common.tokenMint,
      gameVault,
      true,
      TOKEN_PROGRAM_ID,
    );
    const legacyGameToken = await getGameTokenPDA(common.tokenMint);

    expect(plan.instructions).toHaveLength(3);
    expect(plan.instructions[1]?.accounts?.[1]?.address).toBe(vaultTokenAccount);
    expect(plan.instructions[1]?.accounts?.[2]?.address).toBe(gameVault);
    expect(initialize.accounts).toHaveLength(11);
    expect(initialize.accounts?.[2]?.role).toBe(AccountRole.READONLY);
    expect(initialize.accounts?.[3]?.address).toBe(common.oracleOperator);
    expect(initialize.accounts?.[3]?.role).toBe(AccountRole.READONLY_SIGNER);
    expect(initialize.accounts?.[4]?.address).toBe(common.tokenMint);
    expect(initialize.accounts?.some((account) => account.address === legacyGameToken)).toBeFalse();
    expect(initialize.programAddress).toBe(PROGRAM_ID);
    expect(initialize.data).toHaveLength(66);
  });

  test("uses the v0.2 GameToken initialization account", async () => {
    const plan = await buildCreateGamePlan(common, "0.2.0");
    const initialize = plan.instructions[1]!;
    const gameToken = await getGameTokenPDA(common.tokenMint);
    expect(plan.instructions).toHaveLength(2);
    expect(initialize.accounts).toHaveLength(12);
    expect(initialize.accounts?.[5]?.address).toBe(gameToken);
  });
});
