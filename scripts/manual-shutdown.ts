import { OracleService } from "../oracle-service.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runManualShutdown() {
  console.log("🛑 Timba Oracle Manual Shutdown");
  console.log("================================");

  const oracle = OracleService.getInstance();

  // Ensure event listeners are stopped to avoid processing between cycles
  await oracle.stopEventListening();

  let cycle = 0;
  let totalCompleted = 0;
  let totalErrors = 0;

  while (true) {
    cycle += 1;
    console.log(`\n▶️  Scan cycle ${cycle}`);
    const stats = await oracle.scanAndCompleteActiveGames();

    totalCompleted += stats.completed;
    totalErrors += stats.errors;

    console.log(
      `   Completed: ${stats.completed}, Not Ready: ${stats.notReady}, Errors: ${stats.errors}`
    );

    if (stats.notReady === 0 && stats.completed === 0) {
      console.log("   No actionable games remaining.");
      break;
    }

    if (stats.notReady > 0) {
      const waitMs = 30_000;
      console.log(
        `   Waiting ${waitMs / 1000}s for remaining games to settle...`
      );
      await wait(waitMs);
    }
  }

  const cleanupSummary = oracle.cleanupOldRecords(0);
  console.log("\n🧹 Cleanup summary:");
  console.log(
    `   Deleted secrets: ${cleanupSummary.deletedSecrets}, deleted games: ${cleanupSummary.deletedGames}`
  );

  console.log("\n✅ Manual shutdown scan complete.");
  console.log(
    `   Total completions: ${totalCompleted}, total errors: ${totalErrors}`
  );
}

runManualShutdown().catch((error) => {
  console.error("❌ Manual shutdown failed:", error);
  process.exit(1);
});
