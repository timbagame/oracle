import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

type PublicKeyRecord = {
  toBase58?: () => string;
  value?: unknown;
  some?: unknown;
  toString?: () => unknown;
  [key: string]: unknown;
};

type PublicKeyInput =
  | PublicKey
  | anchor.web3.PublicKey
  | string
  | PublicKeyRecord
  | null
  | undefined;

export type PublicKeyLike = PublicKeyInput;

export function coercePublicKey(value: PublicKeyLike): PublicKey | null {
  if (!value) {
    return null;
  }

  if (value instanceof PublicKey) {
    return value;
  }

  if (value instanceof anchor.web3.PublicKey) {
    return new PublicKey(value.toBytes());
  }

  if (typeof value === "string") {
    try {
      return new PublicKey(value);
    } catch {
      return null;
    }
  }

  if (value instanceof Uint8Array) {
    return new PublicKey(value);
  }

  if (Array.isArray(value)) {
    return new PublicKey(value);
  }

  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return new PublicKey(new Uint8Array(value.buffer));
  }

  if (typeof value === "object") {
    const candidate = value as PublicKeyRecord;

    if (typeof candidate.toBase58 === "function") {
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
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);

  const withToNumber = value as { toNumber?: () => number };
  if (typeof withToNumber.toNumber === "function") {
    return withToNumber.toNumber();
  }

  const withValueOf = value as { valueOf?: () => number | bigint };
  if (typeof withValueOf.valueOf === "function") {
    const raw = withValueOf.valueOf();
    if (typeof raw === "number") return raw;
    if (typeof raw === "bigint") return Number(raw);
  }

  return undefined;
}
