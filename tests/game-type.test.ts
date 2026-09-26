import { describe, expect, test } from "bun:test";
import { MAX_GAME_TYPE_LENGTH, normalizeGameType } from "../game-type.ts";

describe("normalizeGameType", () => {
  test("ignores non-string and blank values", () => {
    expect(normalizeGameType(42)).toEqual({ value: undefined });
    expect(normalizeGameType(undefined)).toEqual({ value: undefined });
    expect(normalizeGameType("   ")).toEqual({ value: undefined });
  });

  test("trims and lower-cases game types", () => {
    expect(normalizeGameType("  CoinFlip ")).toEqual({ value: "coinflip", originalLength: 8 });
  });

  test("truncates long values only when allowed", () => {
    const long = "x".repeat(MAX_GAME_TYPE_LENGTH + 2);

    expect(normalizeGameType(long)).toEqual({
      error: `gameType must be at most ${MAX_GAME_TYPE_LENGTH} characters`,
      originalLength: MAX_GAME_TYPE_LENGTH + 2,
    });
    expect(normalizeGameType("abcdef", { maxLength: 3, allowTruncate: true })).toEqual({
      value: "abc",
      truncated: true,
      originalLength: 6,
    });
  });
});
