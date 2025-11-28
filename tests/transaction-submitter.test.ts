import { describe, expect, it, mock } from "bun:test";
import {
  TransactionExpiredTimeoutError,
  TransactionExpiredBlockheightExceededError,
} from "@solana/web3.js";
import { TransactionSubmitter } from "../transaction-submitter.ts";

const latestBlockhash = {
  blockhash: "BH1",
  lastValidBlockHeight: 123,
};

const makeConnection = () => {
  return {
    getLatestBlockhash: mock(async () => latestBlockhash),
    sendRawTransaction: mock(async () => "sig-1"),
    getSignatureStatus: mock(async () => null),
  } as any;
};

const noopSign = async () => Buffer.from("00", "hex");

describe("TransactionSubmitter", () => {
  it("retries with a fresh blockhash after expiry errors", async () => {
    const connection = makeConnection();

    let call = 0;
    const confirmTransaction = mock(async () => {
      call++;
      if (call === 1) {
        throw new TransactionExpiredBlockheightExceededError("expired");
      }
    });

    const submitter = new TransactionSubmitter({
      getConnection: () => connection,
      confirmTransaction,
    });

    // Second send should return a different signature
    connection.sendRawTransaction.mockImplementationOnce(async () => "sig-1");
    connection.sendRawTransaction.mockImplementationOnce(async () => "sig-2");

    const result = await submitter.submitTransaction(noopSign);

    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(2);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(confirmTransaction).toHaveBeenCalledTimes(2);
    expect(result).toBe("sig-2");
  });

  it("returns first signature when status shows the expired tx landed", async () => {
    const connection = makeConnection();

    const confirmTransaction = mock(async () => {
      throw new TransactionExpiredTimeoutError("timeout", 0);
    });

    connection.getSignatureStatus.mockImplementation(async () => ({
      value: { confirmationStatus: "confirmed", err: null },
    }));

    const submitter = new TransactionSubmitter({
      getConnection: () => connection,
      confirmTransaction,
    });

    const result = await submitter.submitTransaction(noopSign);

    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(connection.getSignatureStatus).toHaveBeenCalledTimes(1);
    expect(result).toBe("sig-1");
  });

  it("propagates non-retryable errors", async () => {
    const connection = makeConnection();
    const confirmTransaction = mock(async () => {
      throw new Error("boom");
    });

    const submitter = new TransactionSubmitter({
      getConnection: () => connection,
      confirmTransaction,
    });

    await expect(submitter.submitTransaction(noopSign)).rejects.toThrow("boom");
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});
