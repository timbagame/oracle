import { PublicKey } from "@solana/web3.js";
import { OracleService } from "../oracle-service.ts";

async function main(): Promise<void> {
  const address = process.argv[2];
  if (!address) {
    console.error("Usage: bun run scripts/inspect-game.ts <gameAddress>");
    process.exit(1);
  }

  const oracle = OracleService.getInstance();
  const completion = oracle.completionManager;
  const gamePda = new PublicKey(address);

  try {
    const gameAccount = await completion.fetchGameAccount(gamePda, address);
    if (!gameAccount) {
      console.log(JSON.stringify({ address, exists: false }, null, 2));
      return;
    }

    const readiness = await completion.evaluateGameReadiness(gamePda, address);

    console.log(JSON.stringify({
      address,
      exists: true,
      ticketsCount: Number(gameAccount.ticketsCount),
      maxTickets: Number(gameAccount.maxTickets),
      minTickets: Number(gameAccount.minTickets),
      lastSlot: Number(gameAccount.lastSlot),
      timeout: Number(gameAccount.timeout),
      createdAt: Number(gameAccount.createdAt),
      readiness,
    }, null, 2));
  } catch (error) {
    console.error("Failed to inspect game:", error);
  } finally {
    await oracle.stopEventListening().catch(() => {});
  }
}

main();
