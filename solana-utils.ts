import * as anchor from "@anchor-lang/core";
import { createHash } from "crypto";
import { PublicKey, type BlockhashWithExpiryBlockHeight } from "@solana/web3.js";

type PublicKeyRecord = {
  toBase58?: () => string;
  value?: unknown;
  some?: unknown;
  toString?: () => unknown;
  [key: string]: unknown;
};

type PublicKeyInput =
  PublicKey | anchor.web3.PublicKey | string | PublicKeyRecord | null | undefined;

export type PublicKeyLike = PublicKeyInput;

function isAnchorPublicKey(value: unknown): value is anchor.web3.PublicKey {
  return value instanceof anchor.web3.PublicKey;
}

function isArrayBufferView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function hasToBase58Method(value: object): value is { toBase58: () => string } {
  return typeof (value as { toBase58?: unknown }).toBase58 === "function";
}

export function coercePublicKey(value: PublicKeyLike): PublicKey | null {
  if (!value) {
    return null;
  }

  if (value instanceof PublicKey) {
    return value;
  }

  if (isAnchorPublicKey(value)) {
    return new PublicKey(value.toBytes());
  }

  if (typeof value === "string") {
    try {
      return new PublicKey(value);
    } catch {
      return null;
    }
  }

  if (value instanceof Uint8Array || Array.isArray(value)) {
    try {
      return new PublicKey(value);
    } catch {
      return null;
    }
  }

  if (isArrayBufferView(value)) {
    try {
      return new PublicKey(new Uint8Array(value.buffer));
    } catch {
      return null;
    }
  }

  if (typeof value === "object") {
    const candidate = value as PublicKeyRecord;

    if (hasToBase58Method(candidate)) {
      try {
        return new PublicKey(candidate.toBase58());
      } catch {
        return null;
      }
    }

    if ("value" in candidate) {
      return coercePublicKey(candidate.value as PublicKeyLike);
    }

    if ("some" in candidate) {
      return coercePublicKey(candidate.some as PublicKeyLike);
    }
  }

  return null;
}

export function ensurePublicKey(value: PublicKeyLike | PublicKey): PublicKey {
  const normalized = value instanceof PublicKey ? value : coercePublicKey(value);
  if (!normalized) {
    throw new Error("Invalid public key provided");
  }
  return normalized;
}

export function toBase58(value: PublicKeyLike): string | undefined {
  const key = coercePublicKey(value);
  if (key) {
    return key.toBase58();
  }

  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const candidate = value as PublicKeyRecord;
    if (typeof candidate.toString === "function") {
      const asString = candidate.toString();
      return typeof asString === "string" ? asString : undefined;
    }
  }

  if (typeof value === "function") {
    const fn = value as (...args: unknown[]) => unknown;
    const result = fn.toString();
    return typeof result === "string" ? result : undefined;
  }

  if (value && typeof value !== "object") {
    const asString = String(value);
    return typeof asString === "string" ? asString : undefined;
  }

  return undefined;
}

export function resolveNumericLike(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    if (!Number.isInteger(value)) return undefined;
    if (!Number.isSafeInteger(value)) return undefined;
    return value;
  }

  if (typeof value === "bigint") {
    if (value < 0n) return undefined;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return Number(value);
  }

  const withToNumber = value as { toNumber?: () => number };
  if (typeof withToNumber.toNumber === "function") {
    return resolveNumericLike(withToNumber.toNumber());
  }

  const withValueOf = value as { valueOf?: () => number | bigint };
  if (typeof withValueOf.valueOf === "function") {
    const raw = withValueOf.valueOf();
    return resolveNumericLike(raw);
  }

  return undefined;
}

/**
 * Confirms a transaction using modern or legacy Solana connection methods.
 * Prefers the modern pattern (getLatestBlockhash + confirmTransaction) for newer Solana SDK versions.
 * Falls back to the legacy confirmTransaction(signature) pattern for compatibility with older SDK versions.
 */
export async function confirmTransaction(
  connection: anchor.web3.Connection,
  signature: string,
  latestBlockhash?: BlockhashWithExpiryBlockHeight,
): Promise<void> {
  const conn = connection as anchor.web3.Connection & {
    getLatestBlockhash?: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  };

  // Modern confirmation (preferred)
  if (typeof conn.confirmTransaction === "function") {
    const resolvedBlockhash =
      latestBlockhash ??
      (typeof conn.getLatestBlockhash === "function" ? await conn.getLatestBlockhash() : null);

    if (resolvedBlockhash) {
      const { blockhash, lastValidBlockHeight } = resolvedBlockhash;
      const result = conn.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        await result;
      }
      return;
    }
  }

  // Legacy confirmation fallback
  if (typeof conn.confirmTransaction === "function") {
    const legacyResult = conn.confirmTransaction(signature);
    if (legacyResult && typeof (legacyResult as PromiseLike<unknown>).then === "function") {
      await legacyResult;
    }
    return;
  }

  throw new Error("Connection does not support transaction confirmation");
}

export function generateUnbiasedRandom(seed: Buffer, max: bigint): bigint {
  if (max <= 0n) {
    throw new Error("Unable to generate unbiased random number - game must be cancelled");
  }

  const maxU64 = 0xffff_ffff_ffff_ffffn;
  const maxValid = maxU64 - (maxU64 % max);

  const entropyHash = createHash("sha256").update(seed).digest();

  for (let startPos = 0; startPos <= entropyHash.length - 8; startPos++) {
    const randomU64 = entropyHash.readBigUInt64LE(startPos);
    if (randomU64 < maxValid) {
      return randomU64 % max;
    }
  }

  throw new Error("Unable to generate unbiased random number - game must be cancelled");
}
