import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey, Transaction, type AccountInfo } from "@solana/web3.js";
import { prepareGameToken } from "../token-onboarding.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  deriveAssociatedTokenAddress,
} from "../token-program.ts";

function accountInfo(data: Buffer, owner = TOKEN_PROGRAM_ID): AccountInfo<Buffer> {
  return { data, executable: false, lamports: 1, owner, rentEpoch: 0 };
}

function mintAccount(decimals: number, isInitialized = true): AccountInfo<Buffer> {
  const data = Buffer.alloc(82);
  data.writeUInt8(decimals, 44);
  data.writeUInt8(isInitialized ? 1 : 0, 45);
  return accountInfo(data);
}

function tokenAccount(mint: PublicKey, owner: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeUInt8(1, 108);
  return accountInfo(data);
}

describe("game token onboarding", () => {
  test("uses canonical mint decimals and keeps an existing operator ATA", async () => {
    const operatorKeypair = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const operatorAta = deriveAssociatedTokenAddress(mint, operatorKeypair.publicKey);
    const connection = {
      getAccountInfo: async (address: PublicKey) =>
        address.equals(mint) ? mintAccount(8) : tokenAccount(mint, operatorKeypair.publicKey),
    };

    await expect(
      prepareGameToken({ connection: connection as any, operatorKeypair, mint }),
    ).resolves.toEqual({ decimals: 8, operatorTokenAccount: operatorAta });
  });

  test("creates a missing operator ATA before returning", async () => {
    const operatorKeypair = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    let sentTransaction: Buffer | undefined;
    let confirmed: unknown;
    const connection = {
      getAccountInfo: async (address: PublicKey) => (address.equals(mint) ? mintAccount(6) : null),
      getLatestBlockhash: async () => ({
        blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 42,
      }),
      sendRawTransaction: async (raw: Buffer) => {
        sentTransaction = raw;
        return "ata-signature";
      },
      confirmTransaction: async (strategy: unknown) => {
        confirmed = strategy;
      },
    };

    const result = await prepareGameToken({
      connection: connection as any,
      operatorKeypair,
      mint,
    });

    expect(result.decimals).toBe(6);
    expect(result.creationSignature).toBe("ata-signature");
    expect(sentTransaction).toBeDefined();
    const instruction = Transaction.from(sentTransaction!).instructions[0]!;
    expect(instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(instruction.data).toEqual(Buffer.from([1]));
    expect(confirmed).toEqual({
      signature: "ata-signature",
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 42,
    });
  });

  test("rejects a failed operator ATA confirmation", async () => {
    const operatorKeypair = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const connection = {
      getAccountInfo: async (address: PublicKey) => (address.equals(mint) ? mintAccount(6) : null),
      getLatestBlockhash: async () => ({
        blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 42,
      }),
      sendRawTransaction: async () => "failed-ata-signature",
      confirmTransaction: async () => ({
        value: { err: { InstructionError: [0, { Custom: 1 }] } },
      }),
    };

    await expect(
      prepareGameToken({ connection: connection as any, operatorKeypair, mint }),
    ).rejects.toThrow("Transaction failed-ata-signature failed");
  });

  test("rejects Token-2022 and uninitialized mint accounts", async () => {
    const operatorKeypair = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const token2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    const connection = {
      getAccountInfo: async () => accountInfo(mintAccount(6).data, token2022),
    };

    await expect(
      prepareGameToken({ connection: connection as any, operatorKeypair, mint }),
    ).rejects.toThrow("initialized legacy SPL Token mint");

    const uninitializedConnection = {
      getAccountInfo: async () => mintAccount(6, false),
    };
    await expect(
      prepareGameToken({
        connection: uninitializedConnection as any,
        operatorKeypair,
        mint,
      }),
    ).rejects.toThrow("initialized legacy SPL Token mint");
  });
});
