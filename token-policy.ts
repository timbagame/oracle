import { address } from "@solana/kit";

export const U64_MAX = 18_446_744_073_709_551_615n;
export const MINIMUM_GAME_USD = "0.10";
export const MINIMUM_AMOUNT_GRACE_BPS = 500n;
const BASIS_POINTS = 10_000n;
const MINIMUM_GAME_USD_NUMERATOR = 1n;
const MINIMUM_GAME_USD_DENOMINATOR = 10n;

import type { TokenPolicyInput as TokenPolicy } from "@timbagame/protocol/oracle";
export type {
  TokenPolicyInput as TokenPolicy,
  CreationPolicyRejectionCode,
} from "@timbagame/protocol/oracle";

export interface StoredTokenPolicy {
  mint: string;
  enabled: boolean;
  decimals: number;
  revision: number;
  effectiveAtMs: number;
}

export function normalizeMint(value: string): string {
  const normalized = value.trim();
  try {
    return address(normalized);
  } catch (error) {
    throw new Error("mint must be a valid Solana address", { cause: error });
  }
}

export function normalizeTokenDecimals(value: string | number): number {
  const normalized = typeof value === "string" ? value.trim() : value;
  if (typeof normalized === "string" && !/^(0|[1-9]\d*)$/.test(normalized)) {
    throw new Error("token decimals must be an integer from 0 to 15");
  }
  const decimals = typeof normalized === "number" ? normalized : Number(normalized);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 15) {
    throw new Error("token decimals must be an integer from 0 to 15");
  }
  return decimals;
}

function positiveDecimalFraction(value: number): { numerator: bigint; denominator: bigint } {
  if (!Number.isFinite(value) || value <= 0) throw new Error("token USD price is invalid");
  const match = value.toString().match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) throw new Error("token USD price is invalid");

  const fraction = match[2] ?? "";
  const digits = `${match[1]}${fraction}`.replace(/^0+/, "") || "0";
  const exponent = Number(match[3] ?? "0") - fraction.length;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
    throw new Error("token USD price exponent is invalid");
  }

  return exponent >= 0
    ? { numerator: BigInt(digits) * 10n ** BigInt(exponent), denominator: 1n }
    : { numerator: BigInt(digits), denominator: 10n ** BigInt(-exponent) };
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export function computeMinimumAmountRaw(priceUsd: number, decimals: number): bigint {
  const normalizedDecimals = normalizeTokenDecimals(decimals);
  const price = positiveDecimalFraction(priceUsd);
  const raw = ceilDivide(
    MINIMUM_GAME_USD_NUMERATOR * price.denominator * 10n ** BigInt(normalizedDecimals),
    MINIMUM_GAME_USD_DENOMINATOR * price.numerator,
  );
  if (raw <= 0n || raw > U64_MAX) throw new Error("dynamic minimum amount exceeds u64");
  return raw;
}

export function acceptedMinimumAmountRaw(recommendedMinimumRaw: bigint): bigint {
  if (recommendedMinimumRaw <= 0n) throw new Error("recommended minimum must be positive");
  return ceilDivide(
    recommendedMinimumRaw * (BASIS_POINTS - MINIMUM_AMOUNT_GRACE_BPS),
    BASIS_POINTS,
  );
}

export function toApiTokenPolicy(policy: StoredTokenPolicy, minimumAmountRaw: bigint): TokenPolicy {
  return {
    mint: policy.mint,
    enabled: policy.enabled,
    minimumAmountRaw: minimumAmountRaw.toString(),
    acceptedMinimumAmountRaw:
      minimumAmountRaw > 0n ? acceptedMinimumAmountRaw(minimumAmountRaw).toString() : "0",
    revision: policy.revision,
    effectiveAt: new Date(policy.effectiveAtMs).toISOString(),
  };
}
