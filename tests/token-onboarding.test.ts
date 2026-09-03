import { describe, expect, test } from "bun:test";
import { AccountLayout, MintLayout } from "@solana/spl-token";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { prepareGameToken } from "../token-onboarding.ts";
import { TOKEN_PROGRAM_ID, deriveAssociatedTokenAddress } from "../token-program.ts";

function accountInfo(data: Buffer, owner = TOKEN_PROGRAM_ID): AccountInfo<Buffer> {
  return { data, executable: false, lamports: 1, owner, rentEpoch: 0 };
}

function mintAccount(decimals: number, isInitialized = true): AccountInfo<Buffer> {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals,
      isInitialized,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return accountInfo(data);
}

function tokenAccount(mint: PublicKey, owner: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount: 0n,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
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
    expect(confirmed).toEqual({
      signature: "ata-signature",
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 42,
    });
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
