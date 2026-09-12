import { describe, expect, test } from "bun:test";
import { address } from "@solana/kit";
import { TIMBA_MINT } from "../web-api/token-utils.ts";
import { validateCreateGameRequest } from "../web-api/create-game-request.ts";

const valid = {
  creator: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
  tokenMint: TIMBA_MINT,
  type: "coinflip" as const,
  amount: "1000000",
  minPlayers: 2,
  maxPlayers: 4,
  timeoutSeconds: 1800,
};

describe("create game request validation", () => {
  test("accepts a supported public game", () => {
    expect(validateCreateGameRequest(valid)).toMatchObject({
      type: "coinflip",
      amount: 1_000_000n,
      minPlayers: 2,
      maxPlayers: 4,
    });
  });

  test("accepts a one-player-minimum giveaway", () => {
    expect(
      validateCreateGameRequest({
        ...valid,
        type: "giveaway",
        minPlayers: 1,
        maxPlayers: 10,
      }),
    ).toMatchObject({ type: "giveaway", minPlayers: 1, maxPlayers: 10 });
  });

  test("accepts dynamically configured token addresses and rejects unsafe bounds", () => {
    expect(validateCreateGameRequest({ ...valid, tokenMint: valid.creator }).tokenMint).toBe(
      address(valid.creator),
    );
    expect(() => validateCreateGameRequest({ ...valid, maxPlayers: 101 })).toThrow(
      "Player limits are invalid",
    );
    expect(() => validateCreateGameRequest({ ...valid, amount: "18446744073709551616" })).toThrow(
      "Amount is too large",
    );
  });

  test("normalizes malformed Solana addresses to a safe validation error", () => {
    expect(() => validateCreateGameRequest({ ...valid, creator: "z".repeat(44) })).toThrow(
      "Invalid creator or token address",
    );
  });
});
