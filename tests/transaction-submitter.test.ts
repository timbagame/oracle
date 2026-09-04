import { describe, expect, it, mock } from "bun:test";
import {
  TransactionExpiredTimeoutError,
  TransactionExpiredBlockheightExceededError,
} from "./helpers/solana-fixtures.ts";
import { TransactionSubmitter } from "../transaction-submitter.ts";

const latestBlockhash = {
  blockhash: "11111111111111111111111111111111" as never,
  lastValidBlockHeight: 123n,
};

const makeConnection = () => {
  return {
    getLatestBlockhash: mock(async () => ({ value: latestBlockhash })),
    sendTransaction: mock(async () => "1".repeat(64)),
    getSignatureStatuses: mock(async () => ({ value: [null] })),
  } as any;
};

const noopSign = async () => "AA==";

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
    connection.sendTransaction.mockImplementationOnce(async () => "1".repeat(64));
    connection.sendTransaction.mockImplementationOnce(async () => "2".repeat(64));

    const result = await submitter.submitTransaction(noopSign);

    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(2);
    expect(connection.sendTransaction).toHaveBeenCalledTimes(2);
    expect(confirmTransaction).toHaveBeenCalledTimes(2);
    expect(result).toBe("2".repeat(64));
  });

  it("returns first signature when status shows the expired tx landed", async () => {
    const connection = makeConnection();

    const confirmTransaction = mock(async () => {
      throw new TransactionExpiredTimeoutError("timeout", 0);
    });

    connection.getSignatureStatuses.mockImplementation(async () => ({
      value: [{ confirmationStatus: "confirmed", err: null }],
    }));

    const submitter = new TransactionSubmitter({
      getConnection: () => connection,
      confirmTransaction,
    });

    const result = await submitter.submitTransaction(noopSign);

    expect(connection.sendTransaction).toHaveBeenCalledTimes(1);
    expect(connection.getSignatureStatuses).toHaveBeenCalledTimes(1);
    expect(result).toBe("1".repeat(64));
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
    expect(connection.sendTransaction).toHaveBeenCalledTimes(1);
  });
});
