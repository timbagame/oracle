import { OracleService } from "../oracle-service.ts";

async function main(): Promise<void> {
  const gameAddress = process.argv[2];
  if (!gameAddress) {
    console.error("Usage: bun run scripts/attempt-completion.ts <gameAddress>");
    process.exit(1);
  }

  const service = await OracleService.getInstance();
  try {
    const result = await service.completeGameNow(gameAddress);

    console.log(JSON.stringify({ result }, null, 2));
  } catch (error) {
    console.error("Failed to attempt completion:", error);
  } finally {
    await service.stopEventListening().catch(() => {});
  }
}

main();
