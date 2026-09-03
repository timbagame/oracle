import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as anchor from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { GameCompletionTransactionBuilder } from "../game-completion-transaction-builder.ts";
import { GAME_TOKEN_SEED, GAME_VAULT_SEED } from "../oracle-accounts.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  deriveAssociatedTokenAddress,
} from "../token-program.ts";
import type { TimbaGameAccount } from "../types/timba.ts";
import { setupOracleServiceEnv } from "./helpers/setup-oracle-service-env.ts";

type OracleServiceClass = typeof import("../oracle-service.ts").OracleService;

let OracleService: OracleServiceClass;
let cleanup: () => void;

beforeAll(async () => {
  const env = await setupOracleServiceEnv("contract-v02-compatibility", {
    CONTRACT_VERSION: "0.2.0",
  });
  OracleService = env.OracleService;
  cleanup = env.cleanup;
});

afterAll(() => cleanup());

describe("v0.2.0 compatibility", () => {
  it("signs legacy initialize and creator-join layouts without the v0.3 Oracle policy", async () => {
    const service = OracleService.getInstance();
    const program = (service as any).program as anchor.Program;
    const operatorKeypair = (service as any).operatorKeypair as Keypair;
    expect((program.idl as any).metadata.version).toBe("0.2.0");
    expect(
      (service.events as any).options.config.map(({ event }: { event: string }) => event),
    ).not.toContain("operatorGameClosed");

    const { randomHash, gameAddress } = service.generateGameSecrets({ gameType: "coinflip" });
    const creator = Keypair.generate();
    const tokenMint = Keypair.generate().publicKey;
    const oracle = PublicKey.findProgramAddressSync([Buffer.from("oracle")], program.programId)[0];
    const gameToken = PublicKey.findProgramAddressSync(
      [GAME_TOKEN_SEED, tokenMint.toBuffer()],
      program.programId,
    )[0];
    const gameVault = PublicKey.findProgramAddressSync(
      [GAME_VAULT_SEED, tokenMint.toBuffer()],
      program.programId,
    )[0];
    const gameVaultTokenAccount = deriveAssociatedTokenAddress(
      tokenMint,
      gameVault,
      true,
      TOKEN_PROGRAM_ID,
    );
    const creatorTokenAccount = deriveAssociatedTokenAddress(tokenMint, creator.publicKey);
    const instruction = new TransactionInstruction({
      programId: program.programId,
      data: new anchor.BorshInstructionCoder(program.idl).encode("initializeGame", {
        config: {
          gameType: { coinflip: {} },
          amount: new anchor.BN(1),
          maxTickets: 2,
          minTickets: 2,
          timeout: new anchor.BN(60),
          isPrivate: false,
        },
        randomHash: Array.from(Buffer.from(randomHash, "hex")),
      }),
      keys: [
        { pubkey: new PublicKey(gameAddress), isSigner: false, isWritable: true },
        { pubkey: creator.publicKey, isSigner: true, isWritable: true },
        { pubkey: oracle, isSigner: false, isWritable: false },
        { pubkey: operatorKeypair.publicKey, isSigner: true, isWritable: false },
        { pubkey: tokenMint, isSigner: false, isWritable: false },
        { pubkey: gameToken, isSigner: false, isWritable: true },
        { pubkey: gameVault, isSigner: false, isWritable: false },
        { pubkey: gameVaultTokenAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    });
    const joinInstruction = new TransactionInstruction({
      programId: program.programId,
      data: new anchor.BorshInstructionCoder(program.idl).encode("joinGame", {}),
      keys: [
        { pubkey: new PublicKey(gameAddress), isSigner: false, isWritable: true },
        { pubkey: creator.publicKey, isSigner: true, isWritable: true },
        { pubkey: program.programId, isSigner: false, isWritable: false },
        { pubkey: tokenMint, isSigner: false, isWritable: false },
        { pubkey: gameToken, isSigner: false, isWritable: true },
        { pubkey: gameVault, isSigner: false, isWritable: false },
        { pubkey: gameVaultTokenAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
        { pubkey: oracle, isSigner: false, isWritable: false },
      ],
    });
    const transaction = new Transaction({
      feePayer: creator.publicKey,
      recentBlockhash: PublicKey.default.toBase58(),
    }).add(instruction, joinInstruction);
    transaction.partialSign(creator);

    await expect(
      service.signGameTransaction(
        transaction
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString("base64"),
      ),
    ).resolves.toEqual(expect.any(String));
  });

  it("builds legacy completion accounts with GameToken and no operator token account", async () => {
    const service = OracleService.getInstance();
    const program = (service as any).program as anchor.Program;
    const operatorKeypair = (service as any).operatorKeypair as Keypair;
    const builder = new GameCompletionTransactionBuilder({
      getProgram: () => program as any,
      operatorKeypair,
      contractVersion: "0.2.0",
    });
    const tokenMint = Keypair.generate().publicKey;

    const completion = await builder.buildCompletionTransaction({
      gameAccount: {
        creator: Keypair.generate().publicKey,
        tokenMint,
      } as TimbaGameAccount,
      winnerAddress: Keypair.generate().publicKey,
      randomHashBuffer: Buffer.alloc(32, 1),
      secretKeyBuffer: Buffer.alloc(32, 2),
      winnerIndex: 0,
    });
    const instruction = await completion.builder.instruction();

    const expectedGameToken = PublicKey.findProgramAddressSync(
      [GAME_TOKEN_SEED, tokenMint.toBuffer()],
      program.programId,
    )[0];
    expect(instruction.keys).toHaveLength(12);
    expect(instruction.keys[2]!.pubkey.equals(expectedGameToken)).toBe(true);
    expect(
      instruction.keys.some(({ pubkey }) =>
        pubkey.equals(deriveAssociatedTokenAddress(tokenMint, operatorKeypair.publicKey)),
      ),
    ).toBe(false);
  });
});
