import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Address } from "@solana/kit";
import { addressBytes, addressIsOnCurve, derivePdaSync } from "./solana-kit.ts";
import { ensureAddress, type PublicKeyLike } from "./solana-utils.ts";

export const TOKEN_PROGRAM_ID = TOKEN_PROGRAM_ADDRESS;
export const ASSOCIATED_TOKEN_PROGRAM_ID = ASSOCIATED_TOKEN_PROGRAM_ADDRESS;

export class TokenOwnerOffCurveError extends Error {
  public override readonly name = "TokenOwnerOffCurveError";
}

export function deriveAssociatedTokenAddress(
  mint: PublicKeyLike,
  owner: PublicKeyLike,
  _allowOwnerOffCurve = false,
  tokenProgramId: PublicKeyLike = TOKEN_PROGRAM_ID,
): Address {
  const mintAddress = ensureAddress(mint);
  const ownerAddress = ensureAddress(owner);
  const tokenProgramAddress = ensureAddress(tokenProgramId);
  if (!_allowOwnerOffCurve && !addressIsOnCurve(ownerAddress)) throw new TokenOwnerOffCurveError();
  return derivePdaSync(ASSOCIATED_TOKEN_PROGRAM_ID, [
    addressBytes(ownerAddress),
    addressBytes(tokenProgramAddress),
    addressBytes(mintAddress),
  ]);
}
