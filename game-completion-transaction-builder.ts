import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./token-program.ts";
import type { Timba } from "./types/contract.ts";
import type { TimbaGameAccount } from "./types/timba.ts";
import { ensurePublicKey } from "./solana-utils.ts";
import { deriveGameAccounts } from "./oracle-accounts.ts";
import type { ContractVersion } from "./contract-idl.ts";

export interface GameCompletionTransactionBuilderOptions {
  getProgram: () => anchor.Program<Timba>;
  operatorKeypair: anchor.web3.Keypair;
  contractVersion: ContractVersion;
}

export class GameCompletionTransactionBuilder {
  constructor(private readonly options: GameCompletionTransactionBuilderOptions) {}

  public async buildCompletionTransaction(args: {
    gameAccount: TimbaGameAccount;
    winnerAddress: PublicKey;
    randomHashBuffer: Buffer;
    secretKeyBuffer: Buffer;
    winnerIndex: number;
  }) {
    const program = this.options.getProgram();
    const { gameAccount, winnerAddress, randomHashBuffer, secretKeyBuffer, winnerIndex } = args;

    const creatorPublicKey = ensurePublicKey(gameAccount.creator);
    const tokenMint = ensurePublicKey(gameAccount.tokenMint);

    const programId = ensurePublicKey(program.programId);

    const {
      gamePda,
      oraclePda,
      gameVaultPda,
      gameTokenPda,
      winnerTokenAccount,
      gameVaultTokenAccount,
      oracleOperatorTokenAccount,
    } = deriveGameAccounts({
      programId,
      randomHash: randomHashBuffer,
      tokenMint,
      winner: winnerAddress,
      oracleOperator: this.options.operatorKeypair.publicKey,
      tokenProgramId: TOKEN_PROGRAM_ID,
    });

    const completeGame = program.methods.completeGame(
      [...randomHashBuffer],
      [...secretKeyBuffer],
      winnerIndex,
    );
    const builder =
      this.options.contractVersion === "0.2.0"
        ? completeGame
            .accountsPartial({
              game: gamePda,
              gameTokenCtx: {
                tokenMint,
                gameToken: gameTokenPda,
                gameVault: gameVaultPda,
                gameTokenAccount: gameVaultTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              },
              oracle: oraclePda,
              oracleOperator: this.options.operatorKeypair.publicKey,
              winner: winnerAddress,
              creator: creatorPublicKey,
              winnerTokenAccount,
            } as never)
            .signers([this.options.operatorKeypair])
        : completeGame
            .accountsPartial({
              game: gamePda,
              oracle: oraclePda,
              oracleOperator: this.options.operatorKeypair.publicKey,
              winner: winnerAddress,
              creator: creatorPublicKey,
              gameVaultCtx: {
                tokenMint,
                gameVault: gameVaultPda,
                gameVaultTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              },
              winnerTokenAccount,
              oracleOperatorTokenAccount,
            })
            .signers([this.options.operatorKeypair]);

    return {
      builder,
      signers: [this.options.operatorKeypair],
    };
  }
}
