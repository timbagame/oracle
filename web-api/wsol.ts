import { createNoopSigner, type Address } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddress,
} from "./token-program.ts";

export function isWrappedSol(mint: Address) {
  return mint === NATIVE_MINT;
}

export async function buildWrapSolInstructions(owner: Address, amount: bigint) {
  if (amount <= 0n) throw new Error("SOL amount must be positive");
  const tokenAccount = await getAssociatedTokenAddress(NATIVE_MINT, owner);
  const instructions = [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      tokenAccount,
      owner,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
    ),
    getTransferSolInstruction({
      source: createNoopSigner(owner),
      destination: tokenAccount,
      amount,
    }),
    createSyncNativeInstruction(tokenAccount, TOKEN_PROGRAM_ID),
  ];
  return { tokenAccount, instructions };
}
