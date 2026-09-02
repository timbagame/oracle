import { PublicKey } from "@solana/web3.js";
import { deriveAssociatedTokenAddress } from "./token-program.ts";

export const GAME_SEED = Buffer.from("game", "utf8");
export const ORACLE_SEED = Buffer.from("oracle", "utf8");
export const GAME_VAULT_SEED = Buffer.from("game_vault", "utf8");

export interface DerivedGameAccounts {
  gamePda: PublicKey;
  oraclePda: PublicKey;
  gameVaultPda: PublicKey;
  winnerTokenAccount: PublicKey;
  gameVaultTokenAccount: PublicKey;
  oracleOperatorTokenAccount: PublicKey;
}

export function deriveGameAccounts(params: {
  programId: PublicKey;
  randomHash: Buffer;
  tokenMint: PublicKey;
  winner: PublicKey;
  oracleOperator: PublicKey;
  tokenProgramId: PublicKey;
  gamePda?: PublicKey;
}): DerivedGameAccounts {
  const { programId, randomHash, tokenMint, winner, oracleOperator, tokenProgramId, gamePda } =
    params;

  const [resolvedGamePda] = gamePda
    ? [gamePda]
    : PublicKey.findProgramAddressSync([GAME_SEED, randomHash], programId);
  const [oraclePda] = PublicKey.findProgramAddressSync([ORACLE_SEED], programId);
  const [gameVaultPda] = PublicKey.findProgramAddressSync(
    [GAME_VAULT_SEED, tokenMint.toBuffer()],
    programId,
  );
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
    winnerTokenAccount,
    gameVaultTokenAccount,
    oracleOperatorTokenAccount,
  };
}
