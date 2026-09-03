import { OracleService } from "../oracle-service.ts";

function usage(): never {
  console.error(
    "Usage:\n" +
      "  bun run admin requeue <game-address>\n" +
      "  bun run admin auto-complete <game-address> <on|off>\n" +
      "  bun run admin token-policy list\n" +
      "  bun run admin token-policy set <mint> <on|off>",
  );
  process.exit(2);
}

const [, , command, ...args] = Bun.argv;
if (!command) usage();

const oracle = OracleService.getInstance();

try {
  if (command === "requeue") {
    const [gameAddress] = args;
    if (!gameAddress) usage();
    const result = oracle.requeueGame(gameAddress);
    if (!result.success) {
      throw new Error(`Unable to requeue game: ${result.reason}`);
    }
    console.log(`Requeued ${gameAddress}`);
  } else if (command === "auto-complete") {
    const [gameAddress, value] = args;
    if (!gameAddress) usage();
    if (value !== "on" && value !== "off") usage();
    const result = oracle.setAutoCompleteDisabled(gameAddress, value === "off");
    if (!result.success) {
      throw new Error(`Unable to update auto-complete: ${result.reason}`);
    }
    console.log(
      `Auto-complete ${result.autoCompleteDisabled ? "disabled" : "enabled"} for ${gameAddress}`,
    );
  } else if (command === "token-policy") {
    const [action, mint, enabledValue] = args;
    if (action === "list" && args.length === 1) {
      console.log(JSON.stringify(await oracle.getTokenPolicies(), null, 2));
    } else if (
      action === "set" &&
      mint &&
      (enabledValue === "on" || enabledValue === "off") &&
      args.length === 3
    ) {
      const policy = await oracle.setTokenPolicy(mint, enabledValue === "on");
      console.log(JSON.stringify(policy, null, 2));
    } else {
      usage();
    }
  } else {
    usage();
  }
} finally {
  await oracle.close();
}
