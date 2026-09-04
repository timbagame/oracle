import type { Signature } from "@solana/kit";
import { logger } from "./logger.ts";
import { sendRpcRequest, type LatestBlockhash, type OracleRpc } from "./solana-kit.ts";

export interface TransactionSubmitterOptions {
  getConnection: () => OracleRpc;
  confirmTransaction: (
    transactionSignature: string,
    latestBlockhash: LatestBlockhash,
  ) => Promise<void>;
}

export class TransactionSubmitter {
  constructor(private readonly options: TransactionSubmitterOptions) {}

  public async submitTransaction(
    signTransaction: (latestBlockhash: LatestBlockhash) => Promise<string>,
    onRetry?: (error: unknown) => void,
  ): Promise<string> {
    const rpc = this.options.getConnection();
    let lastSignature: Signature | undefined;

    const sendWithBlockhash = async (latestBlockhash: LatestBlockhash): Promise<string> => {
      const wireTransaction = await signTransaction(latestBlockhash);
      const transactionSignature = await sendRpcRequest(
        rpc.sendTransaction(wireTransaction as never, {
          encoding: "base64",
          maxRetries: 3n,
          preflightCommitment: "confirmed",
          skipPreflight: false,
        }),
      );
      lastSignature = transactionSignature as Signature;
      await this.options.confirmTransaction(transactionSignature, latestBlockhash);
      return transactionSignature;
    };

    let latestBlockhash = this.normalizeLatestBlockhash(
      await sendRpcRequest(rpc.getLatestBlockhash({ commitment: "confirmed" })),
    );
    try {
      return await sendWithBlockhash(latestBlockhash);
    } catch (error) {
      if (!this.shouldRetryAfterExpiry(error)) throw error;
      onRetry?.(error);

      if (lastSignature) {
        try {
          const { value } = await sendRpcRequest(
            rpc.getSignatureStatuses([lastSignature], { searchTransactionHistory: true }),
          );
          const status = value[0];
          if (
            !status?.err &&
            (status?.confirmationStatus === "confirmed" ||
              status?.confirmationStatus === "finalized")
          ) {
            return lastSignature;
          }
        } catch (statusError) {
          logger.warning(`Failed to check status of expired tx ${lastSignature}:`, statusError);
        }
      }

      latestBlockhash = this.normalizeLatestBlockhash(
        await sendRpcRequest(rpc.getLatestBlockhash({ commitment: "confirmed" })),
      );
      return sendWithBlockhash(latestBlockhash);
    }
  }

  private normalizeLatestBlockhash(
    response: { value: LatestBlockhash } | LatestBlockhash,
  ): LatestBlockhash {
    const value = "value" in response ? response.value : response;
    return {
      blockhash: value.blockhash,
      lastValidBlockHeight: BigInt(value.lastValidBlockHeight),
    };
  }

  private shouldRetryAfterExpiry(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /blockhash not found|block height exceeded|transaction expired|expired before confirmation/i.test(
      message,
    );
  }
}
