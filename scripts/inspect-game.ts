import { address as solanaAddress } from "@solana/kit";
import { OracleService } from "../oracle-service.ts";

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const address = argv[0];
  if (!address) {
    console.error("Usage: bun run scripts/inspect-game.ts <gameAddress>");
    process.exit(1);
  }

  const oracle = await OracleService.getInstance();
  const completion = oracle.completionManager;
  const gamePda = solanaAddress(address);

  try {
    const gameAccount = await completion.fetchGameAccount(gamePda);
    if (!gameAccount) {
      console.log(JSON.stringify({ address, exists: false }, null, 2));
      return;
    }

    const readiness = await completion.evaluateGameReadiness(gamePda);

    console.log(
      JSON.stringify(
        {
          address,
          exists: true,
          ticketsCount: Number(gameAccount.ticketsCount),
          maxTickets: Number(gameAccount.maxTickets),
          minTickets: Number(gameAccount.minTickets),
          lastSlot: Number(gameAccount.lastSlot),
          timeout: Number(gameAccount.timeout),
          createdAt: Number(gameAccount.createdAt),
          readiness,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error("Failed to inspect game:", error);
  } finally {
    await oracle.stopEventListening().catch(() => {});
  }
}

if (import.meta.main) {
  main();
}
