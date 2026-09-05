import {
  findAssociatedTokenPda,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { isOffCurveAddress, type Address } from "@solana/kit";
import { ensureAddress, type PublicKeyLike } from "./solana-utils.ts";

export const TOKEN_PROGRAM_ID = TOKEN_PROGRAM_ADDRESS;
export const ASSOCIATED_TOKEN_PROGRAM_ID = ASSOCIATED_TOKEN_PROGRAM_ADDRESS;

export class TokenOwnerOffCurveError extends Error {
  public override readonly name = "TokenOwnerOffCurveError";
}

export async function deriveAssociatedTokenAddress(
  mint: PublicKeyLike,
  owner: PublicKeyLike,
  _allowOwnerOffCurve = false,
  tokenProgramId: PublicKeyLike = TOKEN_PROGRAM_ID,
): Promise<Address> {
  const mintAddress = ensureAddress(mint);
  const ownerAddress = ensureAddress(owner);
  const tokenProgramAddress = ensureAddress(tokenProgramId);
  if (!_allowOwnerOffCurve && isOffCurveAddress(ownerAddress)) throw new TokenOwnerOffCurveError();
  return (
    await findAssociatedTokenPda({
      mint: mintAddress,
      owner: ownerAddress,
      tokenProgram: tokenProgramAddress,
    })
  )[0];
}
