import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as anchor from "./helpers/solana-fixtures.ts";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "./helpers/solana-fixtures.ts";
import { GameCompletionTransactionBuilder } from "../game-completion-transaction-builder.ts";
const GAME_TOKEN_SEED = Buffer.from("game_token");
const GAME_VAULT_SEED = Buffer.from("game_vault");
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
    const service = await OracleService.getInstance();
    const program = (service as any).program as anchor.Program;
    const operatorKeypair = (service as any).operatorKeypair as Keypair;
    const programId = new PublicKey(String(program.programId));
    const operatorPublicKey = new PublicKey(operatorKeypair.address);
    expect((program.idl as any).metadata.version).toBe("0.2.0");
    expect(
      (service.events as any).options.config.map(({ event }: { event: string }) => event),
    ).not.toContain("operatorGameClosed");

    const { randomHash, gameAddress } = await service.generateGameSecrets({ gameType: "coinflip" });
    const creator = Keypair.generate();
    const tokenMint = Keypair.generate().publicKey;
    const oracle = PublicKey.findProgramAddressSync([Buffer.from("oracle")], programId)[0];
    const gameToken = PublicKey.findProgramAddressSync(
      [GAME_TOKEN_SEED, tokenMint.toBuffer()],
      programId,
    )[0];
    const gameVault = PublicKey.findProgramAddressSync(
      [GAME_VAULT_SEED, tokenMint.toBuffer()],
      programId,
    )[0];
    const gameVaultTokenAccount = await deriveAssociatedTokenAddress(
      tokenMint,
      gameVault,
      true,
      TOKEN_PROGRAM_ID,
    );
    const creatorTokenAccount = await deriveAssociatedTokenAddress(tokenMint, creator.publicKey);
    const instruction = new TransactionInstruction({
      programId,
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
        { pubkey: operatorPublicKey, isSigner: true, isWritable: false },
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
      programId,
      data: new anchor.BorshInstructionCoder(program.idl).encode("joinGame", {}),
      keys: [
        { pubkey: new PublicKey(gameAddress), isSigner: false, isWritable: true },
        { pubkey: creator.publicKey, isSigner: true, isWritable: true },
        { pubkey: programId, isSigner: false, isWritable: false },
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
    const service = await OracleService.getInstance();
    const program = (service as any).program as anchor.Program;
    const operatorKeypair = (service as any).operatorKeypair as Keypair;
    const programId = new PublicKey(String(program.programId));
    const operatorPublicKey = new PublicKey(operatorKeypair.address);
    const builder = new GameCompletionTransactionBuilder({
      programId: programId.address,
      operator: operatorKeypair,
      contractVersion: "0.2.0",
    });
    const tokenMint = Keypair.generate().publicKey;

    const instruction = await builder.buildCompletionInstruction({
      gameAccount: {
        creator: Keypair.generate().publicKey,
        tokenMint,
      } as TimbaGameAccount,
      winnerAddress: Keypair.generate().publicKey.address,
      randomHashBuffer: Buffer.alloc(32, 1),
      secretKeyBuffer: Buffer.alloc(32, 2),
      winnerIndex: 0,
    });
    const expectedGameToken = PublicKey.findProgramAddressSync(
      [GAME_TOKEN_SEED, tokenMint.toBuffer()],
      programId,
    )[0];
    expect(instruction.accounts).toHaveLength(12);
    expect(instruction.accounts![2]!.address).toBe(expectedGameToken.address);
    const operatorAta = await deriveAssociatedTokenAddress(tokenMint, operatorPublicKey);
    expect(instruction.accounts!.some(({ address }) => address === operatorAta)).toBe(false);
  });
});
