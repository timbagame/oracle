import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

type PublicKeyInput =
  | PublicKey
  | anchor.web3.PublicKey
  | string
  | { [key: string]: any }
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

  if (typeof value === "object") {
    if (typeof (value as any).toBase58 === "function") {
      try {
        return new PublicKey((value as any).toBase58());
      } catch {
        return null;
      }
    }

    if ("value" in (value as any)) {
      return coercePublicKey((value as any).value);
    }

    if ("some" in (value as any)) {
      return coercePublicKey((value as any).some);
    }
  }

  try {
    return new PublicKey(value as any);
  } catch {
    return null;
  }
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

  if (value && typeof (value as any).toString === "function") {
    const asString = (value as any).toString();
    return typeof asString === "string" ? asString : undefined;
  }

  return undefined;
}
