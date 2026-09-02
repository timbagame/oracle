import { PublicKey } from "@solana/web3.js";

export const U64_MAX = 18_446_744_073_709_551_615n;

export type CreationPolicyRejectionCode =
  "unsupported_mint" | "token_disabled" | "amount_below_minimum" | "policy_unavailable";

export interface TokenPolicy {
  mint: string;
  enabled: boolean;
  minimumAmountRaw: string;
  revision: number;
  effectiveAt: string;
}

export interface StoredTokenPolicy {
  mint: string;
  enabled: boolean;
  minimumAmountRaw: string;
  revision: number;
  effectiveAtMs: number;
}

export function normalizeMint(value: string): string {
  const normalized = value.trim();
  try {
    return new PublicKey(normalized).toBase58();
  } catch (error) {
    throw new Error("mint must be a valid Solana address", { cause: error });
  }
}

export function normalizeMinimumAmountRaw(value: string): string {
  const normalized = value.trim();
  if (!/^(0|[1-9]\d*)$/.test(normalized)) {
    throw new Error("minimum amount must be a non-negative integer in raw token units");
  }

  const amount = BigInt(normalized);
  if (amount > U64_MAX) {
    throw new Error("minimum amount exceeds u64");
  }
  return amount.toString();
}

export function toApiTokenPolicy(policy: StoredTokenPolicy): TokenPolicy {
  return {
    mint: policy.mint,
    enabled: policy.enabled,
    minimumAmountRaw: policy.minimumAmountRaw,
    revision: policy.revision,
    effectiveAt: new Date(policy.effectiveAtMs).toISOString(),
  };
}
