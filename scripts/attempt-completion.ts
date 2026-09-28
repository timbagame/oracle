import { OracleService } from "../oracle-service.ts";

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const gameAddress = argv[0];
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

if (import.meta.main) await main();
