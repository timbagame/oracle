import { PublicKey, type Connection } from "@solana/web3.js";
import { delay } from "../delay.ts";
import { logger } from "../logger.ts";
import { IndexerDatabase } from "./database.ts";
import { findStaleActiveGames, getEventsSince, getProgramHead } from "./solana.ts";

export class PublicIndexer {
  private running = false;

  constructor(
    readonly database: IndexerDatabase,
    private readonly connection: Connection,
    private readonly programId: PublicKey,
    private readonly pollIntervalMs: number,
  ) {}

  async runOnce(): Promise<{ indexed: number; transactions: number }> {
    const cursor = this.database.getCursor();
    if (!cursor) {
      const head = await getProgramHead(this.connection, this.programId);
      if (head) this.database.setCursor(head);
      logger.warning(
        "Indexer cursor initialized at the current program head; import the D1 export before cutover to retain history.",
      );
      await this.safelyReconcileActiveGames();
      return { indexed: 0, transactions: 0 };
    }

    const result = await getEventsSince(this.connection, this.programId, cursor);
    const indexed = result.cursor ? this.database.apply(result.events, result.cursor) : 0;
    await this.safelyReconcileActiveGames();
    return { indexed, transactions: result.transactions };
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!signal.aborted) {
        try {
          const result = await this.runOnce();
          if (result.transactions > 0) {
            logger.info(
              `Public indexer processed ${result.transactions} transactions and ${result.indexed} game changes.`,
            );
          }
        } catch (error) {
          logger.failure("Public indexer cycle failed; cursor was not advanced:", error);
        }
        await delay(this.pollIntervalMs, { signal });
      }
    } finally {
      this.running = false;
    }
  }

  private async reconcileActiveGames(): Promise<void> {
    const games = this.database.getActiveGames();
    if (games.length === 0) return;
    const stale = await findStaleActiveGames(
      this.connection,
      this.programId,
      games.map((game) => game.game_key),
    );
    this.database.removeStaleActiveGames(stale);
  }

  private async safelyReconcileActiveGames(): Promise<void> {
    try {
      await this.reconcileActiveGames();
    } catch (error) {
      logger.warning("Public indexer active-game reconciliation failed:", error);
    }
  }
}
