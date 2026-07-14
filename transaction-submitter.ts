import * as anchor from "@anchor-lang/core";
import {
  SendTransactionError,
  TransactionExpiredBlockheightExceededError,
  TransactionExpiredTimeoutError,
  type BlockhashWithExpiryBlockHeight,
  type SendOptions,
  type Connection,
} from "@solana/web3.js";
import { logger } from "./logger.ts";

export interface TransactionSubmitterOptions {
  getConnection: () => Connection;
  confirmTransaction: (
    signature: string,
    latestBlockhash?: BlockhashWithExpiryBlockHeight,
  ) => Promise<void>;
  confirmOpts?: anchor.web3.ConfirmOptions;
}

export class TransactionSubmitter {
  constructor(private readonly options: TransactionSubmitterOptions) {}

  public async submitTransaction(
    signTransaction: (latestBlockhash: BlockhashWithExpiryBlockHeight) => Promise<Buffer>,
    onRetry?: (error: unknown) => void,
  ): Promise<string> {
    const connection = this.options.getConnection();
    const { confirmOpts } = this.options;
    const blockhashCommitment =
      confirmOpts?.preflightCommitment ?? confirmOpts?.commitment ?? "confirmed";

    const sendOptions: SendOptions = {};
    if (confirmOpts?.skipPreflight !== undefined) {
      sendOptions.skipPreflight = confirmOpts.skipPreflight;
    }
    if (confirmOpts?.preflightCommitment ?? confirmOpts?.commitment) {
      sendOptions.preflightCommitment = confirmOpts.preflightCommitment ?? confirmOpts.commitment;
    }
    if (confirmOpts?.maxRetries !== undefined) {
      sendOptions.maxRetries = confirmOpts.maxRetries;
    }
    if (confirmOpts?.minContextSlot !== undefined) {
      sendOptions.minContextSlot = confirmOpts.minContextSlot;
    }

    let lastSignature: string | undefined;

    const sendWithBlockhash = async (
      latestBlockhash: BlockhashWithExpiryBlockHeight,
    ): Promise<string> => {
      const rawTransaction = await signTransaction(latestBlockhash);
      const signature = await connection.sendRawTransaction(rawTransaction, sendOptions);
      lastSignature = signature;
      await this.options.confirmTransaction(signature, latestBlockhash);
      return signature;
    };

    let latestBlockhash = await connection.getLatestBlockhash(blockhashCommitment);

    try {
      return await sendWithBlockhash(latestBlockhash);
    } catch (error) {
      const retryable = this.shouldRetryAfterExpiry(error);

      // Only invoke onRetry hooks for expiry-like failures where a retry makes sense.
      if (retryable && onRetry) {
        onRetry(error);
      }

      if (!retryable) {
        throw error;
      }

      // Check if the previous transaction actually landed
      if (lastSignature) {
        try {
          const status = await connection.getSignatureStatus(lastSignature);
          if (
            status?.value?.confirmationStatus === "confirmed" ||
            status?.value?.confirmationStatus === "finalized"
          ) {
            if (!status.value.err) {
              return lastSignature;
            }
          }
        } catch (statusError) {
          logger.warning(`Failed to check status of expired tx ${lastSignature}:`, statusError);
        }
      }

      latestBlockhash = await connection.getLatestBlockhash(blockhashCommitment);
      return await sendWithBlockhash(latestBlockhash);
    }
  }

  private shouldRetryAfterExpiry(error: unknown): boolean {
    if (error instanceof TransactionExpiredBlockheightExceededError) {
      return true;
    }
    if (error instanceof TransactionExpiredTimeoutError) {
      return true;
    }
    return this.isBlockhashExpirySendError(error);
  }

  private isBlockhashExpirySendError(error: unknown): boolean {
    if (!(error instanceof SendTransactionError)) {
      return false;
    }

    const blockhashNotFoundPattern = /blockhash not found/i;
    const transactionError = error.transactionError;
    const segments = [
      error.message,
      transactionError?.message,
      ...(error.logs ?? []),
      ...(transactionError?.logs ?? []),
    ].filter((segment): segment is string => typeof segment === "string" && segment.length > 0);

    return segments.some((segment) => blockhashNotFoundPattern.test(segment));
  }
}
