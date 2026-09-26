import { describe, expect, it } from "bun:test";
import { generateUnbiasedRandom } from "../solana-utils.ts";

describe("solana-utils.generateUnbiasedRandom", () => {
  it("throws when max is zero", () => {
    const seed = Buffer.alloc(32, 1);
    expect(() => generateUnbiasedRandom(seed, 0n)).toThrow(
      "Unable to generate unbiased random number - game must be cancelled",
    );
  });
});
