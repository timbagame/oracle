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

describe("solana-utils.PublicKey", () => {
  it("exposes the address in every legacy representation", async () => {
    const { PublicKey, ensurePublicKey } = await import("../solana-utils.ts");
    const bytes = new Uint8Array(32).fill(7);
    const key = new PublicKey(bytes);

    expect(Array.from(key.toBytes())).toEqual(Array.from(bytes));
    expect(key.toBuffer().equals(Buffer.from(bytes))).toBe(true);
    expect(key.toString()).toBe(key.toBase58());
    expect(key.equals(key.toBase58())).toBe(true);
    expect(key.equals(new PublicKey(new Uint8Array(32).fill(8)))).toBe(false);
    expect(ensurePublicKey(key)).toBe(key);
    expect(ensurePublicKey(key.toBase58()).toBase58()).toBe(key.toBase58());
    expect(() => ensurePublicKey("not a key")).toThrow("Invalid public key provided");
  });
});
