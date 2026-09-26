import { describe, expect, test } from "bun:test";
import {
  acceptedMinimumAmountRaw,
  computeMinimumAmountRaw,
  MINIMUM_AMOUNT_GRACE_BPS,
  MINIMUM_GAME_USD,
} from "../token-policy.ts";

describe("dynamic token minimum", () => {
  test("converts the $0.10 target to raw token units with upward rounding", () => {
    expect(MINIMUM_GAME_USD).toBe("0.10");
    expect(computeMinimumAmountRaw(1, 6)).toBe(100_000n);
    expect(computeMinimumAmountRaw(100, 9)).toBe(1_000_000n);
    expect(computeMinimumAmountRaw(0.000004, 6)).toBe(25_000_000_000n);
    expect(computeMinimumAmountRaw(3, 2)).toBe(4n);
  });

  test("applies a five-percent acceptance band without reaching zero", () => {
    expect(MINIMUM_AMOUNT_GRACE_BPS).toBe(500n);
    expect(acceptedMinimumAmountRaw(100n)).toBe(95n);
    expect(acceptedMinimumAmountRaw(101n)).toBe(96n);
    expect(acceptedMinimumAmountRaw(2n)).toBe(2n);
    expect(acceptedMinimumAmountRaw(1n)).toBe(1n);
  });

  test("rejects unusable prices and raw amounts above u64", () => {
    expect(() => computeMinimumAmountRaw(0, 6)).toThrow("token USD price is invalid");
    expect(() => computeMinimumAmountRaw(Number.NaN, 6)).toThrow("token USD price is invalid");
    expect(() => computeMinimumAmountRaw(1e-100, 15)).toThrow("dynamic minimum amount exceeds u64");
  });
});

describe("computeMinimumAmountRaw price parsing", () => {
  test("rejects prices whose decimal exponent is out of range", () => {
    expect(() => computeMinimumAmountRaw(1e-120, 6)).toThrow("token USD price exponent is invalid");
  });
});
