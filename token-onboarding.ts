import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type EncodedAccount,
} from "@solana/kit";
import {
  addressBytes,
  ensureKeyPairSigner,
  fetchAccount,
  sendRpcRequest,
  type KeyPairSignerLike,
  type OracleRpc,
} from "./solana-kit.ts";
import { confirmTransaction, ensureAddress, type PublicKeyLike } from "./solana-utils.ts";
import { TOKEN_PROGRAM_ID, deriveAssociatedTokenAddress } from "./token-program.ts";
import { normalizeTokenDecimals } from "./token-policy.ts";

const LEGACY_MINT_ACCOUNT_SIZE = 82;
const MINT_DECIMALS_OFFSET = 44;
const MINT_INITIALIZED_OFFSET = 45;
const LEGACY_TOKEN_ACCOUNT_SIZE = 165;
const TOKEN_ACCOUNT_MINT_OFFSET = 0;
const TOKEN_ACCOUNT_OWNER_OFFSET = 32;
const TOKEN_ACCOUNT_STATE_OFFSET = 108;
const TOKEN_ACCOUNT_INITIALIZED = 1;

function decodeMintDecimals(mint: Address, account: EncodedAccount): number {
  const data = Buffer.from(account.data);
  if (
    account.programAddress !== TOKEN_PROGRAM_ID ||
    data.length !== LEGACY_MINT_ACCOUNT_SIZE ||
    data[MINT_INITIALIZED_OFFSET] !== 1
  ) {
    throw new Error(`Token mint must be an initialized legacy SPL Token mint: ${mint}`);
  }
  return normalizeTokenDecimals(data[MINT_DECIMALS_OFFSET]!);
}

function assertOperatorTokenAccount(
  accountAddress: Address,
  account: EncodedAccount,
  mint: Address,
  owner: Address,
): void {
  const data = Buffer.from(account.data);
  const mintBytes = Buffer.from(addressBytes(mint));
  const ownerBytes = Buffer.from(addressBytes(owner));
  if (
    account.programAddress !== TOKEN_PROGRAM_ID ||
    data.length !== LEGACY_TOKEN_ACCOUNT_SIZE ||
    data[TOKEN_ACCOUNT_STATE_OFFSET] !== TOKEN_ACCOUNT_INITIALIZED ||
    !data.subarray(TOKEN_ACCOUNT_MINT_OFFSET, TOKEN_ACCOUNT_OWNER_OFFSET).equals(mintBytes) ||
    !data.subarray(TOKEN_ACCOUNT_OWNER_OFFSET, TOKEN_ACCOUNT_OWNER_OFFSET + 32).equals(ownerBytes)
  ) {
    throw new Error(`Operator token account is invalid: ${accountAddress}`);
  }
}

export interface PreparedGameToken {
  decimals: number;
  operatorTokenAccount: Address;
  creationSignature?: string;
}

export async function prepareGameToken(options: {
  connection: OracleRpc;
  operatorKeypair: KeyPairSignerLike;
  mint: PublicKeyLike;
}): Promise<PreparedGameToken> {
  const connection = options.connection;
  const operatorKeypair = ensureKeyPairSigner(options.operatorKeypair);
  const mint = ensureAddress(options.mint);
  const mintAccount = await fetchAccount(connection, mint);
  if (!mintAccount) throw new Error(`Token mint does not exist: ${mint}`);
  const decimals = decodeMintDecimals(mint, mintAccount);

  const operatorTokenAccount = await deriveAssociatedTokenAddress(mint, operatorKeypair.address);
  const existingAccount = await fetchAccount(connection, operatorTokenAccount);
  if (existingAccount) {
    assertOperatorTokenAccount(
      operatorTokenAccount,
      existingAccount,
      mint,
      operatorKeypair.address,
    );
    return { decimals, operatorTokenAccount };
  }

  const { value: lifetime } = await sendRpcRequest(
    connection.getLatestBlockhash({ commitment: "confirmed" }),
  );
  const instruction = getCreateAssociatedTokenIdempotentInstruction({
    payer: operatorKeypair,
    ata: operatorTokenAccount,
    owner: operatorKeypair.address,
    mint,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (value) => setTransactionMessageFeePayerSigner(operatorKeypair, value),
    (value) => setTransactionMessageLifetimeUsingBlockhash(lifetime, value),
    (value) => appendTransactionMessageInstruction(instruction, value),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const wireTransaction = getBase64EncodedWireTransaction(transaction);
  const creationSignature = await sendRpcRequest(
    connection.sendTransaction(wireTransaction, {
      encoding: "base64",
      maxRetries: 3n,
      preflightCommitment: "confirmed",
      skipPreflight: false,
    }),
  );
  await confirmTransaction(connection, creationSignature, lifetime);
  return { decimals, operatorTokenAccount, creationSignature };
}
