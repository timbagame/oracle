import type { Address, ReadonlyUint8Array } from "@solana/kit";
import { addressBytes, derivePdaSync } from "./solana-kit.ts";
import { ensureAddress, type PublicKeyLike } from "./solana-utils.ts";
import { deriveAssociatedTokenAddress } from "./token-program.ts";

export const GAME_SEED = Buffer.from("game", "utf8");
export const ORACLE_SEED = Buffer.from("oracle", "utf8");
export const GAME_VAULT_SEED = Buffer.from("game_vault", "utf8");
export const GAME_TOKEN_SEED = Buffer.from("game_token", "utf8");

export interface DerivedGameAccounts {
  gamePda: Address;
  oraclePda: Address;
  gameVaultPda: Address;
  gameTokenPda: Address;
  winnerTokenAccount: Address;
  gameVaultTokenAccount: Address;
  oracleOperatorTokenAccount: Address;
}

export function deriveGameAccounts(params: {
  programId: PublicKeyLike;
  randomHash: ReadonlyUint8Array;
  tokenMint: PublicKeyLike;
  winner: PublicKeyLike;
  oracleOperator: PublicKeyLike;
  tokenProgramId: PublicKeyLike;
  gamePda?: PublicKeyLike;
}): DerivedGameAccounts {
  const programId = ensureAddress(params.programId);
  const tokenMint = ensureAddress(params.tokenMint);
  const winner = ensureAddress(params.winner);
  const oracleOperator = ensureAddress(params.oracleOperator);
  const tokenProgramId = ensureAddress(params.tokenProgramId);

  const resolvedGamePda = params.gamePda
    ? ensureAddress(params.gamePda)
    : derivePdaSync(programId, [GAME_SEED, params.randomHash]);
  const oraclePda = derivePdaSync(programId, [ORACLE_SEED]);
  const gameVaultPda = derivePdaSync(programId, [GAME_VAULT_SEED, addressBytes(tokenMint)]);
  const gameTokenPda = derivePdaSync(programId, [GAME_TOKEN_SEED, addressBytes(tokenMint)]);
  const winnerTokenAccount = deriveAssociatedTokenAddress(tokenMint, winner, false, tokenProgramId);
  const gameVaultTokenAccount = deriveAssociatedTokenAddress(
    tokenMint,
    gameVaultPda,
    true,
    tokenProgramId,
  );
  const oracleOperatorTokenAccount = deriveAssociatedTokenAddress(
    tokenMint,
    oracleOperator,
    false,
    tokenProgramId,
  );

  return {
    gamePda: resolvedGamePda,
    oraclePda,
    gameVaultPda,
    gameTokenPda,
    winnerTokenAccount,
    gameVaultTokenAccount,
    oracleOperatorTokenAccount,
  };
}
