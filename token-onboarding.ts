import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountInfo,
  type Connection,
  type Keypair,
} from "@solana/web3.js";
import { confirmTransaction } from "./solana-utils.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  deriveAssociatedTokenAddress,
} from "./token-program.ts";
import { normalizeTokenDecimals } from "./token-policy.ts";

const LEGACY_MINT_ACCOUNT_SIZE = 82;
const MINT_DECIMALS_OFFSET = 44;
const MINT_INITIALIZED_OFFSET = 45;
const LEGACY_TOKEN_ACCOUNT_SIZE = 165;
const TOKEN_ACCOUNT_MINT_OFFSET = 0;
const TOKEN_ACCOUNT_OWNER_OFFSET = 32;
const TOKEN_ACCOUNT_STATE_OFFSET = 108;
const TOKEN_ACCOUNT_INITIALIZED = 1;

function decodeMintDecimals(mint: PublicKey, account: AccountInfo<Buffer>): number {
  if (
    !account.owner.equals(TOKEN_PROGRAM_ID) ||
    account.data.length !== LEGACY_MINT_ACCOUNT_SIZE ||
    account.data[MINT_INITIALIZED_OFFSET] !== 1
  ) {
    throw new Error(`Token mint must be an initialized legacy SPL Token mint: ${mint.toBase58()}`);
  }
  return normalizeTokenDecimals(account.data[MINT_DECIMALS_OFFSET]!);
}

function assertOperatorTokenAccount(
  address: PublicKey,
  account: AccountInfo<Buffer>,
  mint: PublicKey,
  owner: PublicKey,
): void {
  const data = account.data;
  if (
    !account.owner.equals(TOKEN_PROGRAM_ID) ||
    data.length !== LEGACY_TOKEN_ACCOUNT_SIZE ||
    data[TOKEN_ACCOUNT_STATE_OFFSET] !== TOKEN_ACCOUNT_INITIALIZED ||
    !new PublicKey(data.subarray(TOKEN_ACCOUNT_MINT_OFFSET, TOKEN_ACCOUNT_OWNER_OFFSET)).equals(
      mint,
    ) ||
    !new PublicKey(
      data.subarray(TOKEN_ACCOUNT_OWNER_OFFSET, TOKEN_ACCOUNT_OWNER_OFFSET + 32),
    ).equals(owner)
  ) {
    throw new Error(`Operator token account is invalid: ${address.toBase58()}`);
  }
}

function createAssociatedTokenAccountIdempotentInstruction(options: {
  payer: PublicKey;
  associatedTokenAccount: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: options.payer, isSigner: true, isWritable: true },
      { pubkey: options.associatedTokenAccount, isSigner: false, isWritable: true },
      { pubkey: options.owner, isSigner: false, isWritable: false },
      { pubkey: options.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export interface PreparedGameToken {
  decimals: number;
  operatorTokenAccount: PublicKey;
  creationSignature?: string;
}

export async function prepareGameToken(options: {
  connection: Connection;
  operatorKeypair: Keypair;
  mint: PublicKey;
}): Promise<PreparedGameToken> {
  const { connection, operatorKeypair, mint } = options;
  const mintAccount = await connection.getAccountInfo(mint, "confirmed");
  if (!mintAccount) throw new Error(`Token mint does not exist: ${mint.toBase58()}`);

  const decimals = decodeMintDecimals(mint, mintAccount);

  const operatorTokenAccount = deriveAssociatedTokenAddress(mint, operatorKeypair.publicKey);
  const existingAccount = await connection.getAccountInfo(operatorTokenAccount, "confirmed");
  if (existingAccount) {
    assertOperatorTokenAccount(
      operatorTokenAccount,
      existingAccount,
      mint,
      operatorKeypair.publicKey,
    );
    return { decimals, operatorTokenAccount };
  }

  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: operatorKeypair.publicKey,
    ...latestBlockhash,
  }).add(
    createAssociatedTokenAccountIdempotentInstruction({
      payer: operatorKeypair.publicKey,
      associatedTokenAccount: operatorTokenAccount,
      owner: operatorKeypair.publicKey,
      mint,
    }),
  );
  transaction.sign(operatorKeypair);
  const creationSignature = await connection.sendRawTransaction(transaction.serialize(), {
    maxRetries: 3,
    skipPreflight: false,
  });
  await confirmTransaction(connection, creationSignature, latestBlockhash);
  return { decimals, operatorTokenAccount, creationSignature };
}
