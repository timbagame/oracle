import { PublicKey } from "@solana/web3.js";
import { deriveAssociatedTokenAddress } from "./token-program.ts";

export const GAME_SEED = Buffer.from("game", "utf8");
export const ORACLE_SEED = Buffer.from("oracle", "utf8");
export const GAME_TOKEN_SEED = Buffer.from("game_token", "utf8");
export const GAME_VAULT_SEED = Buffer.from("game_vault", "utf8");

export interface DerivedGameAccounts {
  gamePda: PublicKey;
  oraclePda: PublicKey;
  gameTokenPda: PublicKey;
  gameVaultPda: PublicKey;
  winnerTokenAccount: PublicKey;
  gameTokenAccount: PublicKey;
}

export function deriveGameAccounts(params: {
  programId: PublicKey;
  randomHash: Buffer;
  tokenMint: PublicKey;
  winner: PublicKey;
  tokenProgramId: PublicKey;
  gamePda?: PublicKey;
}): DerivedGameAccounts {
  const { programId, randomHash, tokenMint, winner, tokenProgramId, gamePda } = params;

  const [resolvedGamePda] = gamePda
    ? [gamePda]
    : PublicKey.findProgramAddressSync([GAME_SEED, randomHash], programId);
  const [oraclePda] = PublicKey.findProgramAddressSync([ORACLE_SEED], programId);
  const [gameTokenPda] = PublicKey.findProgramAddressSync(
    [GAME_TOKEN_SEED, tokenMint.toBuffer()],
    programId,
  );
  const [gameVaultPda] = PublicKey.findProgramAddressSync(
    [GAME_VAULT_SEED, tokenMint.toBuffer()],
    programId,
  );
  const winnerTokenAccount = deriveAssociatedTokenAddress(tokenMint, winner, false, tokenProgramId);
  const gameTokenAccount = deriveAssociatedTokenAddress(
    tokenMint,
    gameVaultPda,
    true,
    tokenProgramId,
  );

  return {
    gamePda: resolvedGamePda,
    oraclePda,
    gameTokenPda,
    gameVaultPda,
    winnerTokenAccount,
    gameTokenAccount,
  };
}
