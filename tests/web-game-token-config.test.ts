import {
  GAME_TOKEN_DISCRIMINATOR,
  getGameTokenEncoder,
} from "@timbagame/protocol/contracts/v0.2.0/kit";
import { describe, expect, test } from "bun:test";
import { address, getAddressEncoder } from "@solana/kit";
import { TokenPolicySchema } from "@timbagame/protocol/oracle";
import { TIMBA_MINT, USDC_MINT } from "../web-api/token-utils.ts";
import { CreateGameValidationError } from "../web-api/create-game-request.ts";
import { PROGRAM_ID } from "../web-api/program.ts";
import { TOKEN_PROGRAM_ID } from "../web-api/token-program.ts";
import {
  assertGameTokenAmount,
  assertGameTokenPolicy,
  decodeGameTokenConfig,
  decodeGameTokenMetadata,
  formatGameTokenPolicies,
} from "../web-api/game-token-config.ts";

const policy = TokenPolicySchema.parse({
  mint: TIMBA_MINT,
  enabled: true,
  minimumAmountRaw: "25034000001",
  acceptedMinimumAmountRaw: "23782300001",
  revision: 3,
  effectiveAt: "2026-09-02T12:00:00.000Z",
});
const metadata = new Map([[TIMBA_MINT, { symbol: "TIMBA", decimals: 6 }]]);

describe("game token policy", () => {
  test("decodes the v0.2 GameToken account layout", () => {
    const data = Buffer.alloc(58);
    data.set(GAME_TOKEN_DISCRIMINATOR);
    Buffer.from(getAddressEncoder().encode(TIMBA_MINT)).copy(data, 8);
    data.writeUInt8(1, 40);
    data.writeBigUInt64LE(25_034_000_001n, 41);
    data.writeUInt8(1, 57);

    expect(decodeGameTokenConfig(TIMBA_MINT, { data, programAddress: PROGRAM_ID })).toMatchObject({
      minimumAmount: "25034.000001",
      minimumAmountRaw: "25034000001",
      enabled: true,
    });
  });

  test("formats Oracle policy without floating-point conversion", () => {
    expect(formatGameTokenPolicies([policy], new Map([[TIMBA_MINT, 0.000004]]), metadata)).toEqual([
      {
        mint: TIMBA_MINT,
        symbol: "TIMBA",
        decimals: 6,
        minimumAmount: "25034.000001",
        minimumAmountRaw: "25034000001",
        enabled: true,
        priceUsd: 0.000004,
      },
    ]);
  });

  test("keeps disabled dynamic tokens displayable", () => {
    const unknownMint = address("US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx");
    const unknownPolicy = TokenPolicySchema.parse({ ...policy, mint: unknownMint, enabled: false });
    expect(formatGameTokenPolicies([unknownPolicy, policy], new Map(), metadata)).toEqual([
      expect.objectContaining({ mint: TIMBA_MINT, enabled: true }),
    ]);
    expect(
      formatGameTokenPolicies(
        [unknownPolicy],
        new Map(),
        new Map([[unknownMint, { symbol: "TEST", decimals: 8 }]]),
      ),
    ).toEqual([expect.objectContaining({ mint: unknownMint, enabled: false })]);
  });

  test("uses mint account decimals and a safe symbol fallback", () => {
    const mint = address("US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx");
    const data = Buffer.alloc(82);
    data.writeUInt8(8, 44);
    data.writeUInt8(1, 45);
    expect(decodeGameTokenMetadata(mint, { data, programAddress: TOKEN_PROGRAM_ID })).toEqual({
      decimals: 8,
      symbol: "US51...ELFx",
    });
    expect(decodeGameTokenMetadata(mint, { data, programAddress: PROGRAM_ID })).toBeNull();
  });

  test("rejects disabled tokens and amounts below the grace band", () => {
    const acceptedMinimum = BigInt(policy.acceptedMinimumAmountRaw);
    expect(() =>
      assertGameTokenPolicy([{ ...policy, enabled: false }], TIMBA_MINT, 30_000_000_000n, metadata),
    ).toThrow("disabled");
    expect(() =>
      assertGameTokenPolicy([policy], TIMBA_MINT, acceptedMinimum - 1n, metadata),
    ).toThrow("Minimum amount is 25034.000001 TIMBA");
    expect(assertGameTokenPolicy([policy], TIMBA_MINT, acceptedMinimum, metadata)).toBe(policy);
  });
});

describe("game token account checks", () => {
  function gameTokenAccount(options: { mint?: string; enabled: boolean; minAmount: bigint }) {
    return getGameTokenEncoder().encode({
      tokenMint: address(options.mint ?? TIMBA_MINT),
      vaultBump: 255,
      minAmount: options.minAmount,
      feeAmount: 0n,
      enabled: options.enabled,
    }) as Uint8Array;
  }

  function rpcWith(data: Uint8Array | null) {
    return {
      getAccountInfo: () => ({
        send: async () => ({
          context: { slot: 1n },
          value: data
            ? {
                data: [Buffer.from(data).toString("base64"), "base64"],
                owner: PROGRAM_ID,
                lamports: 1n,
                executable: false,
                space: BigInt(data.length),
              }
            : null,
        }),
      }),
    } as never;
  }

  test("accepts an amount at the enabled token minimum", async () => {
    const rpc = rpcWith(gameTokenAccount({ enabled: true, minAmount: 5_000_000n }));

    await expect(assertGameTokenAmount(rpc, TIMBA_MINT, 5_000_000n)).resolves.toMatchObject({
      symbol: "TIMBA",
      minimumAmount: "5",
    });
  });

  test("rejects disabled tokens and amounts below the minimum", async () => {
    await expect(
      assertGameTokenAmount(
        rpcWith(gameTokenAccount({ enabled: false, minAmount: 1n })),
        TIMBA_MINT,
        10n,
      ),
    ).rejects.toThrow(CreateGameValidationError);
    await expect(
      assertGameTokenAmount(
        rpcWith(gameTokenAccount({ enabled: true, minAmount: 5_000_000n })),
        TIMBA_MINT,
        4_999_999n,
      ),
    ).rejects.toMatchObject({ publicMessage: "Minimum amount is 5 TIMBA" });
  });

  test("treats a missing or foreign configuration account as unavailable", async () => {
    await expect(assertGameTokenAmount(rpcWith(null), TIMBA_MINT, 1n)).rejects.toThrow(
      "TIMBA game configuration is unavailable",
    );
    const otherMint = gameTokenAccount({ mint: USDC_MINT, enabled: true, minAmount: 1n });
    expect(() =>
      decodeGameTokenConfig(TIMBA_MINT, { data: otherMint, programAddress: PROGRAM_ID }),
    ).toThrow("TIMBA game configuration is unavailable");
  });
});
