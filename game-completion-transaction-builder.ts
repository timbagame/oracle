import type { Address, Instruction, KeyPairSigner, ReadonlyUint8Array } from "@solana/kit";
import { getCompleteGameInstruction as getCompleteGameInstructionV020 } from "@timbagame/protocol/contracts/v0.2.0/kit";
import { getCompleteGameInstruction as getCompleteGameInstructionV030 } from "@timbagame/protocol/contracts/v0.3.0/kit";
import type { ContractVersion } from "./contract-idl.ts";
import { deriveGameAccounts } from "./oracle-accounts.ts";
import { ensureAddress } from "./solana-utils.ts";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./token-program.ts";
import type { TimbaGameAccount } from "./types/timba.ts";

export interface GameCompletionTransactionBuilderOptions {
  programId: Address;
  operator: KeyPairSigner;
  contractVersion: ContractVersion;
}

export class GameCompletionTransactionBuilder {
  constructor(private readonly options: GameCompletionTransactionBuilderOptions) {}

  public async buildCompletionInstruction(args: {
    gameAccount: TimbaGameAccount;
    winnerAddress: Address;
    randomHashBuffer: ReadonlyUint8Array;
    secretKeyBuffer: ReadonlyUint8Array;
    winnerIndex: number;
  }): Promise<Instruction> {
    const { gameAccount, winnerAddress, randomHashBuffer, secretKeyBuffer, winnerIndex } = args;
    const creator = ensureAddress(gameAccount.creator);
    const tokenMint = ensureAddress(gameAccount.tokenMint);
    const accounts = await deriveGameAccounts({
      contractVersion: this.options.contractVersion,
      programId: this.options.programId,
      randomHash: randomHashBuffer,
      tokenMint,
      winner: winnerAddress,
      oracleOperator: this.options.operator.address,
      tokenProgramId: TOKEN_PROGRAM_ID,
    });
    const common = {
      game: accounts.gamePda,
      tokenMint,
      gameVault: accounts.gameVaultPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      oracle: accounts.oraclePda,
      oracleOperator: this.options.operator,
      winner: winnerAddress,
      creator,
      winnerTokenAccount: accounts.winnerTokenAccount,
      randomHash: randomHashBuffer,
      secretKey: secretKeyBuffer,
      winnerIndex,
    };

    return this.options.contractVersion === "0.2.0"
      ? getCompleteGameInstructionV020(
          {
            ...common,
            gameToken: accounts.gameTokenPda,
            gameTokenAccount: accounts.gameVaultTokenAccount,
          },
          { programAddress: this.options.programId },
        )
      : getCompleteGameInstructionV030(
          {
            ...common,
            gameVaultTokenAccount: accounts.gameVaultTokenAccount,
            oracleOperatorTokenAccount: accounts.oracleOperatorTokenAccount,
          },
          { programAddress: this.options.programId },
        );
  }
}
