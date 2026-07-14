import { OracleService } from "../oracle-service.ts";

function usage(): never {
  console.error(
    "Usage:\n" +
      "  bun run admin requeue <game-address>\n" +
      "  bun run admin auto-complete <game-address> <on|off>",
  );
  process.exit(2);
}

const [, , command, gameAddress, value] = Bun.argv;
if (!command || !gameAddress) usage();

const oracle = OracleService.getInstance();

try {
  if (command === "requeue") {
    const result = oracle.requeueGame(gameAddress);
    if (!result.success) {
      throw new Error(`Unable to requeue game: ${result.reason}`);
    }
    console.log(`Requeued ${gameAddress}`);
  } else if (command === "auto-complete") {
    if (value !== "on" && value !== "off") usage();
    const result = oracle.setAutoCompleteDisabled(gameAddress, value === "off");
    if (!result.success) {
      throw new Error(`Unable to update auto-complete: ${result.reason}`);
    }
    console.log(
      `Auto-complete ${result.autoCompleteDisabled ? "disabled" : "enabled"} for ${gameAddress}`,
    );
  } else {
    usage();
  }
} finally {
  await oracle.close();
}
