import type { Address, ReadonlyUint8Array } from "@solana/kit";
import { getContractClient } from "@timbagame/protocol/contracts/client";
import { findGameTokenPda } from "@timbagame/protocol/contracts/v0.2.0/kit";
import type { ContractVersion } from "@timbagame/protocol/contracts";
import { ensureAddress, type PublicKeyLike } from "./solana-utils.ts";
import { deriveAssociatedTokenAddress } from "./token-program.ts";

export interface DerivedGameAccounts {
  gamePda: Address;
  oraclePda: Address;
  gameVaultPda: Address;
  gameTokenPda: Address;
  winnerTokenAccount: Address;
  gameVaultTokenAccount: Address;
  oracleOperatorTokenAccount: Address;
}

export async function deriveGameAccounts(params: {
  contractVersion: ContractVersion;
  programId: PublicKeyLike;
  randomHash: ReadonlyUint8Array;
  tokenMint: PublicKeyLike;
  winner: PublicKeyLike;
  oracleOperator: PublicKeyLike;
  tokenProgramId: PublicKeyLike;
  gamePda?: PublicKeyLike;
}): Promise<DerivedGameAccounts> {
  const programId = ensureAddress(params.programId);
  const tokenMint = ensureAddress(params.tokenMint);
  const winner = ensureAddress(params.winner);
  const oracleOperator = ensureAddress(params.oracleOperator);
  const tokenProgramId = ensureAddress(params.tokenProgramId);

  if (params.randomHash.length !== 32) throw new Error("Game random hash must be 32 bytes");
  const client = getContractClient(params.contractVersion);
  const config = { programAddress: programId };
  const resolvedGamePda = params.gamePda
    ? ensureAddress(params.gamePda)
    : (await client.findGamePda({ randomHash: params.randomHash }, config))[0];
  const [[oraclePda], [gameVaultPda], [gameTokenPda]] = await Promise.all([
    client.findOraclePda(config),
    client.findGameVaultPda({ tokenMint }, config),
    findGameTokenPda({ tokenMint }, config),
  ]);
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
