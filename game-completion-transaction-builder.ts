import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { Timba } from "./idl/idlType.ts";
import type { TimbaGameAccount } from "./types/timba.ts";
import { ensurePublicKey, resolveTokenProgram } from "./solana-utils.ts";
import { deriveGameAccounts } from "./oracle-accounts.ts";

export interface GameCompletionTransactionBuilderOptions {
  getProgram: () => anchor.Program<Timba>;
  adminKeypair: anchor.web3.Keypair;
  tokenProgramCache: Map<string, PublicKey>;
  getConnection: () => anchor.web3.Connection;
}

export class GameCompletionTransactionBuilder {
  constructor(private readonly options: GameCompletionTransactionBuilderOptions) {}

  public async buildCompletionTransaction(args: {
    gameAccount: TimbaGameAccount;
    winnerAddress: PublicKey;
    randomHashBuffer: Buffer;
    secretKeyBuffer: Buffer;
    winnerIndex: number;
  }): Promise<{
    builder: any; // Using any to avoid deep import issues with Anchor types
    signers: anchor.web3.Keypair[];
  }> {
    const program = this.options.getProgram();
    const { gameAccount, winnerAddress, randomHashBuffer, secretKeyBuffer, winnerIndex } = args;

    const creatorPublicKey = ensurePublicKey(gameAccount.creator);
    const tokenMint = ensurePublicKey(gameAccount.tokenMint);

    const tokenProgramId = await resolveTokenProgram(
      this.options.getConnection(),
      tokenMint,
      gameAccount.tokenProgram,
      this.options.tokenProgramCache,
    );

    const programId = ensurePublicKey(program.programId);

    const { gamePda, oraclePda, gameTokenPda, gameVaultPda, winnerTokenAccount, gameTokenAccount } =
      deriveGameAccounts({
        programId,
        randomHash: randomHashBuffer,
        tokenMint,
        winner: winnerAddress,
        tokenProgramId,
      });

    const gameTokenCtx = {
      tokenMint,
      gameToken: gameTokenPda,
      gameVault: gameVaultPda,
      gameTokenAccount,
      tokenProgram: tokenProgramId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    } as const;

    const builder = program.methods
      .completeGame([...randomHashBuffer], [...secretKeyBuffer], winnerIndex)
      .accountsPartial({
        game: gamePda,
        oracle: oraclePda,
        oracleOperator: this.options.adminKeypair.publicKey,
        winner: winnerAddress,
        creator: creatorPublicKey,
        gameTokenCtx,
        winnerTokenAccount,
      })
      .signers([this.options.adminKeypair]);

    return {
      builder,
      signers: [this.options.adminKeypair],
    };
  }
}
