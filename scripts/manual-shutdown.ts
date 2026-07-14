import { OracleService } from "../oracle-service.ts";

async function runManualShutdown() {
  console.log("🛑 Timba Oracle Manual Shutdown");
  console.log("================================");

  const oracle = OracleService.getInstance();

  // Ensure event listeners are stopped to avoid processing between cycles
  await oracle.stopEventListening();

  const waitMs = 30_000;
  const summary = await oracle.scanRunner.runScanLoop({
    waitBetweenCyclesMs: waitMs,
    waitForPendingOnly: true,
    onCycleStart: (cycle) => {
      console.log(`\n▶️  Scan cycle ${cycle}`);
    },
    onCycleComplete: (_cycle, stats) => {
      console.log(
        `   Completed: ${stats.completed}, Not Ready: ${stats.notReady}, Errors: ${stats.errors}`,
      );

      if (stats.notReady === 0 && stats.completed === 0) {
        console.log("   No actionable games remaining.");
      } else if (stats.notReady > 0) {
        console.log(`   Waiting ${waitMs / 1000}s for remaining games to settle...`);
      }
    },
  });

  const cleanupSummary = oracle.cleanupOldRecords(0);
  console.log("\n🧹 Cleanup summary:");
  console.log(
    `   Deleted secrets: ${cleanupSummary.deletedSecrets}, deleted games: ${cleanupSummary.deletedGames}, deleted players: ${cleanupSummary.deletedPlayers}`,
  );

  console.log("\n✅ Manual shutdown scan complete.");
  console.log(
    `   Total completions: ${summary.totalCompleted}, total errors: ${summary.totalErrors}`,
  );
}

runManualShutdown().catch((error) => {
  console.error("❌ Manual shutdown failed:", error);
  process.exit(1);
});
