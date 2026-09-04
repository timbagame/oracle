import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
  compileTransaction,
  decompileTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  isSignerRole,
  isWritableRole,
  partiallySignTransactionWithSigners,
  verifySignature,
  type AccountMeta,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  type Transaction,
} from "@solana/kit";
import {
  INITIALIZE_GAME_DISCRIMINATOR as INITIALIZE_GAME_DISCRIMINATOR_V020,
  JOIN_GAME_DISCRIMINATOR as JOIN_GAME_DISCRIMINATOR_V020,
  getInitializeGameInstructionDataDecoder as getInitializeDecoderV020,
  getJoinGameInstructionDataDecoder as getJoinDecoderV020,
} from "@timbagame/protocol/contracts/v0.2.0/kit";
import {
  INITIALIZE_GAME_DISCRIMINATOR as INITIALIZE_GAME_DISCRIMINATOR_V030,
  JOIN_GAME_DISCRIMINATOR as JOIN_GAME_DISCRIMINATOR_V030,
  getInitializeGameInstructionDataDecoder as getInitializeDecoderV030,
  getJoinGameInstructionDataDecoder as getJoinDecoderV030,
} from "@timbagame/protocol/contracts/v0.3.0/kit";
import type { ContractVersion } from "./contract-idl.ts";
import { GAME_TOKEN_SEED, GAME_VAULT_SEED, ORACLE_SEED } from "./oracle-accounts.ts";
import { addressBytes, derivePda } from "./solana-kit.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  deriveAssociatedTokenAddress,
} from "./token-program.ts";

const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111" as Address;
const PHANTOM_LIGHTHOUSE_PROGRAM_ID = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95" as Address;
const PHANTOM_ASSERT_OWNER_PROGRAM_ID = "DeJBGdMFa1uynnnKiwrVioatTuHmNLpyFKnmB5kaFdzQ" as Address;
const ALLOWED_SETUP_PROGRAMS = new Set<Address>([
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  PHANTOM_LIGHTHOUSE_PROGRAM_ID,
  PHANTOM_ASSERT_OWNER_PROGRAM_ID,
]);

export class TransactionPolicyError extends Error {}

function hasDiscriminator(data: ReadonlyUint8Array, discriminator: ReadonlyUint8Array): boolean {
  return (
    data.length >= discriminator.length &&
    discriminator.every((byte, index) => data[index] === byte)
  );
}

function assertMeta(
  meta: AccountMeta | undefined,
  options: { address?: Address; signer: boolean; writable: boolean; message: string },
): asserts meta is AccountMeta {
  if (
    !meta ||
    (options.address !== undefined && meta.address !== options.address) ||
    isSignerRole(meta.role) !== options.signer ||
    isWritableRole(meta.role) !== options.writable
  ) {
    throw new TransactionPolicyError(options.message);
  }
}

function hasAdvanceNonceInstruction(instruction: Instruction | undefined): boolean {
  if (instruction?.programAddress !== SYSTEM_PROGRAM_ADDRESS || !instruction.data) return false;
  const data = Buffer.from(instruction.data);
  return data.length >= 4 && data.readUInt32LE(0) === 4;
}

export interface SignGameTransactionOptions {
  contractVersion: ContractVersion;
  programId: Address;
  operator: KeyPairSigner;
  getGamePda: (randomHash: ReadonlyUint8Array) => Promise<Address>;
  assertCreationPolicy: (tokenMint: Address, amount: bigint) => Promise<void>;
  assertUnusedCommitment: (gameAddress: Address, randomHashHex: string) => void;
  markCommitmentSigned: (gameAddress: Address) => void;
}

export async function signGameTransactionWithPolicy(
  txBase64: string,
  options: SignGameTransactionOptions,
): Promise<string> {
  let transaction: Transaction;
  let message;
  try {
    transaction = getTransactionDecoder().decode(getBase64Encoder().encode(txBase64));
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    message = decompileTransactionMessage(compiled);
  } catch (error) {
    throw new TransactionPolicyError("Invalid transaction payload", { cause: error });
  }
  if (message.version !== "legacy") {
    throw new TransactionPolicyError("Only legacy game transactions are supported");
  }
  if (hasAdvanceNonceInstruction(message.instructions[0])) {
    throw new TransactionPolicyError("Durable nonce transactions are not supported");
  }

  const programInstructions = message.instructions.filter(
    (instruction) => instruction.programAddress === options.programId,
  );
  if (programInstructions.length < 1 || programInstructions.length > 2) {
    throw new TransactionPolicyError(
      "Transaction must contain initialization and an optional creator join",
    );
  }

  const initialize = programInstructions[0]!;
  const usesLegacyGameToken = options.contractVersion === "0.2.0";
  const expectedInitializeAccounts = usesLegacyGameToken ? 12 : 11;
  if (initialize.accounts?.length !== expectedInitializeAccounts || !initialize.data) {
    throw new TransactionPolicyError("Invalid initialize-game account list");
  }
  let initializeData;
  try {
    const discriminator = usesLegacyGameToken
      ? INITIALIZE_GAME_DISCRIMINATOR_V020
      : INITIALIZE_GAME_DISCRIMINATOR_V030;
    if (!hasDiscriminator(initialize.data, discriminator)) {
      throw new Error("Unexpected instruction discriminator");
    }
    initializeData = usesLegacyGameToken
      ? getInitializeDecoderV020().decode(initialize.data)
      : getInitializeDecoderV030().decode(initialize.data);
  } catch (error) {
    throw new TransactionPolicyError("Invalid game instruction data", { cause: error });
  }

  const metas = initialize.accounts;
  const game = metas[0]!;
  const creator = metas[1]!;
  const oracle = metas[2]!;
  const operator = metas[3]!;
  const tokenMint = metas[4]!;
  const gameToken = usesLegacyGameToken ? metas[5]! : undefined;
  const offset = usesLegacyGameToken ? 1 : 0;
  const gameVault = metas[5 + offset]!;
  const gameVaultTokenAccount = metas[6 + offset]!;
  const tokenProgram = metas[7 + offset]!;
  const associatedTokenProgram = metas[8 + offset]!;
  const creatorTokenAccount = metas[9 + offset]!;
  const systemProgram = metas[10 + offset]!;

  assertMeta(game, { signer: false, writable: true, message: "Invalid game account flags" });
  assertMeta(creator, {
    address: message.feePayer.address,
    signer: true,
    writable: true,
    message: "Creator must be the transaction fee payer and signer",
  });
  if (!isSignerRole(operator.role) || isWritableRole(operator.role)) {
    throw new TransactionPolicyError("Invalid oracle operator account");
  }
  const operatorAlreadySet = operator.address === options.operator.address;
  const operatorPlaceholder = operatorAlreadySet ? null : operator.address;

  const [expectedOracle, expectedGameToken, expectedGameVault] = await Promise.all([
    derivePda(options.programId, [ORACLE_SEED]),
    derivePda(options.programId, [GAME_TOKEN_SEED, addressBytes(tokenMint.address)]),
    derivePda(options.programId, [GAME_VAULT_SEED, addressBytes(tokenMint.address)]),
  ]);
  assertMeta(oracle, {
    address: expectedOracle,
    signer: false,
    writable: false,
    message: "Invalid oracle account",
  });
  assertMeta(tokenMint, {
    signer: false,
    writable: false,
    message: "Invalid token mint account flags",
  });
  if (gameToken) {
    assertMeta(gameToken, {
      address: expectedGameToken,
      signer: false,
      writable: true,
      message: "Invalid game token account",
    });
  }
  assertMeta(gameVault, {
    address: expectedGameVault,
    signer: false,
    writable: false,
    message: "Invalid game vault account",
  });
  const [expectedVaultAta, expectedCreatorAta] = await Promise.all([
    deriveAssociatedTokenAddress(tokenMint.address, expectedGameVault, true),
    deriveAssociatedTokenAddress(tokenMint.address, creator.address),
  ]);
  assertMeta(gameVaultTokenAccount, {
    address: expectedVaultAta,
    signer: false,
    writable: true,
    message: "Invalid game vault token account",
  });
  assertMeta(tokenProgram, {
    address: TOKEN_PROGRAM_ID,
    signer: false,
    writable: false,
    message: "Invalid token program account",
  });
  assertMeta(associatedTokenProgram, {
    address: ASSOCIATED_TOKEN_PROGRAM_ID,
    signer: false,
    writable: false,
    message: "Invalid associated token program account",
  });
  assertMeta(creatorTokenAccount, {
    address: expectedCreatorAta,
    signer: false,
    writable: true,
    message: "Invalid creator token account",
  });
  assertMeta(systemProgram, {
    address: SYSTEM_PROGRAM_ADDRESS,
    signer: false,
    writable: false,
    message: "Invalid system program account",
  });

  const randomHash = Buffer.from(initializeData.randomHash);
  if (randomHash.length !== 32) throw new TransactionPolicyError("Invalid random hash");
  const expectedGame = await options.getGamePda(randomHash);
  if (game.address !== expectedGame) {
    throw new TransactionPolicyError("Game account does not match the committed random hash");
  }
  options.assertUnusedCommitment(expectedGame, randomHash.toString("hex"));

  const join = programInstructions[1];
  if (join) {
    if (!operatorAlreadySet) {
      throw new TransactionPolicyError("Atomic creator join requires the creator to sign first");
    }
    validateCreatorJoin(join, {
      usesLegacyGameToken,
      game: game.address,
      creator: creator.address,
      operator: options.operator.address,
      isPrivate: initializeData.isPrivate,
      tokenMint: tokenMint.address,
      gameToken: expectedGameToken,
      gameVault: expectedGameVault,
      gameVaultTokenAccount: expectedVaultAta,
      creatorTokenAccount: expectedCreatorAta,
      oracle: expectedOracle,
      programId: options.programId,
    });
  }

  for (const instruction of message.instructions) {
    if (instruction === initialize || instruction === join) continue;
    if (!ALLOWED_SETUP_PROGRAMS.has(instruction.programAddress)) {
      throw new TransactionPolicyError(
        `Unsupported setup instruction in game transaction: ${instruction.programAddress}`,
      );
    }
    if (instruction.accounts?.some((meta) => meta.address === options.operator.address)) {
      throw new TransactionPolicyError(
        "Oracle operator cannot be referenced by setup instructions",
      );
    }
  }

  if (operatorAlreadySet) {
    const creatorSignature = transaction.signatures[creator.address];
    if (
      !creatorSignature ||
      !(await verifySignature(
        await getPublicKeyFromAddress(creator.address),
        creatorSignature,
        transaction.messageBytes,
      ))
    ) {
      throw new TransactionPolicyError("Creator signature is missing or invalid");
    }
  }
  if (!usesLegacyGameToken) {
    await options.assertCreationPolicy(tokenMint.address, initializeData.amount);
  }

  const transactionToSign = operatorPlaceholder
    ? compileTransaction({
        ...message,
        instructions: message.instructions.map((instruction) =>
          instruction === initialize
            ? {
                ...instruction,
                accounts: instruction.accounts?.map((meta, index) =>
                  index === 3 ? { ...meta, address: options.operator.address } : meta,
                ),
              }
            : instruction,
        ),
      })
    : transaction;
  const signed = await partiallySignTransactionWithSigners([options.operator], transactionToSign);
  options.markCommitmentSigned(expectedGame);
  return getBase64EncodedWireTransaction(signed);
}

function validateCreatorJoin(
  join: Instruction,
  values: {
    usesLegacyGameToken: boolean;
    game: Address;
    creator: Address;
    operator: Address;
    isPrivate: boolean;
    tokenMint: Address;
    gameToken: Address;
    gameVault: Address;
    gameVaultTokenAccount: Address;
    creatorTokenAccount: Address;
    oracle: Address;
    programId: Address;
  },
): void {
  const expectedAccounts = values.usesLegacyGameToken ? 11 : 10;
  if (join.accounts?.length !== expectedAccounts || !join.data) {
    throw new TransactionPolicyError("Invalid creator join instruction");
  }
  try {
    const discriminator = values.usesLegacyGameToken
      ? JOIN_GAME_DISCRIMINATOR_V020
      : JOIN_GAME_DISCRIMINATOR_V030;
    if (!hasDiscriminator(join.data, discriminator)) {
      throw new Error("Unexpected instruction discriminator");
    }
    (values.usesLegacyGameToken ? getJoinDecoderV020() : getJoinDecoderV030()).decode(join.data);
  } catch (error) {
    throw new TransactionPolicyError("Invalid creator join instruction", { cause: error });
  }
  const metas = join.accounts;
  const offset = values.usesLegacyGameToken ? 1 : 0;
  assertMeta(metas[0], {
    address: values.game,
    signer: false,
    writable: true,
    message: "Creator join uses an invalid game account",
  });
  assertMeta(metas[1], {
    address: values.creator,
    signer: true,
    writable: true,
    message: "Creator join uses an invalid creator account",
  });
  assertMeta(metas[2], {
    address: values.isPrivate ? values.operator : values.programId,
    signer: values.isPrivate,
    writable: false,
    message: "Creator join uses an invalid optional oracle operator",
  });
  assertMeta(metas[3], {
    address: values.tokenMint,
    signer: false,
    writable: false,
    message: "Creator join token mint does not match initialization",
  });
  if (values.usesLegacyGameToken) {
    assertMeta(metas[4], {
      address: values.gameToken,
      signer: false,
      writable: true,
      message: "Creator join uses an invalid game token",
    });
  }
  assertMeta(metas[4 + offset], {
    address: values.gameVault,
    signer: false,
    writable: false,
    message: "Creator join uses an invalid game vault",
  });
  assertMeta(metas[5 + offset], {
    address: values.gameVaultTokenAccount,
    signer: false,
    writable: true,
    message: "Creator join uses an invalid game vault token account",
  });
  assertMeta(metas[6 + offset], {
    address: TOKEN_PROGRAM_ID,
    signer: false,
    writable: false,
    message: "Creator join uses an invalid token program",
  });
  assertMeta(metas[7 + offset], {
    address: ASSOCIATED_TOKEN_PROGRAM_ID,
    signer: false,
    writable: false,
    message: "Creator join uses an invalid associated token program",
  });
  assertMeta(metas[8 + offset], {
    address: values.creatorTokenAccount,
    signer: false,
    writable: true,
    message: "Creator join uses an invalid player token account",
  });
  assertMeta(metas[9 + offset], {
    address: values.oracle,
    signer: false,
    writable: false,
    message: "Creator join uses an invalid oracle account",
  });
}
