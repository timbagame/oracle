import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { PublicKey, Transaction, type Connection, type Keypair } from "@solana/web3.js";
import { confirmTransaction } from "./solana-utils.ts";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./token-program.ts";
import { normalizeTokenDecimals } from "./token-policy.ts";

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

  let decimals: number;
  try {
    const decodedMint = unpackMint(mint, mintAccount, TOKEN_PROGRAM_ID);
    if (!decodedMint.isInitialized) throw new Error("mint is not initialized");
    decimals = normalizeTokenDecimals(decodedMint.decimals);
  } catch (error) {
    throw new Error(`Token mint must be an initialized legacy SPL Token mint: ${mint.toBase58()}`, {
      cause: error,
    });
  }

  const operatorTokenAccount = getAssociatedTokenAddressSync(
    mint,
    operatorKeypair.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const existingAccount = await connection.getAccountInfo(operatorTokenAccount, "confirmed");
  if (existingAccount) {
    try {
      const account = unpackAccount(operatorTokenAccount, existingAccount, TOKEN_PROGRAM_ID);
      if (!account.mint.equals(mint) || !account.owner.equals(operatorKeypair.publicKey)) {
        throw new Error("associated token account has unexpected mint or owner");
      }
    } catch (error) {
      throw new Error(`Operator token account is invalid: ${operatorTokenAccount.toBase58()}`, {
        cause: error,
      });
    }
    return { decimals, operatorTokenAccount };
  }

  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: operatorKeypair.publicKey,
    ...latestBlockhash,
  }).add(
    createAssociatedTokenAccountIdempotentInstruction(
      operatorKeypair.publicKey,
      operatorTokenAccount,
      operatorKeypair.publicKey,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  );
  transaction.sign(operatorKeypair);
  const creationSignature = await connection.sendRawTransaction(transaction.serialize(), {
    maxRetries: 3,
    skipPreflight: false,
  });
  await confirmTransaction(connection, creationSignature, latestBlockhash);
  return { decimals, operatorTokenAccount, creationSignature };
}
