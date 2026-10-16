// Reproduces the transaction built by web-api/api.ts for /web/games/prepare.
// Usage: bun web-prepare.mjs <ref-dir>
const ref = process.argv[2];
const plans = await import(`${ref}/node_modules/@timbagame/protocol/dist/solana/plans/index.js`);
const PROGRAM_ID = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";
const creator = "HGBiGfyR9GF36J4SMPjxsRkFuwYNuNYuzdCjgR4aw4FC";
const operator = "4oRdwjBqMGjhh5octi4BLvtNGCgWdJDMv3bBr9Jpi5V8";
const randomHash = new Uint8Array(32).fill(7);
async function prepare(version, input) {
  const plan = await plans.buildCreateGamePlan(
    { ...input, creator, timeoutSeconds: BigInt(input.timeoutSeconds), randomHash, oracleOperator: operator },
    version,
    PROGRAM_ID,
  );
  const instructions = [...plan.instructions];
  if (input.type === "coinflip") {
    const adapter = plans.createContractAdapter(version, PROGRAM_ID);
    const join = await adapter.buildJoinPlan({
      game: plan.game,
      player: creator,
      tokenMint: input.tokenMint,
      tokenAmount: input.amount,
    });
    instructions.push(...join.instructions.slice(1));
  }
  const tx = plans.createLegacyTransaction(
    creator,
    { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100n },
    instructions,
  );
  return { gameAddress: plan.game, txBase64: plans.encodeTransactionBase64(tx) };
}
const out = {
  "0.2.0": await prepare("0.2.0", {
    tokenMint: "So11111111111111111111111111111111111111112",
    type: "coinflip",
    amount: 1000000n,
    minPlayers: 2,
    maxPlayers: 2,
    timeoutSeconds: 600,
  }),
  "0.3.0": await prepare("0.3.0", {
    tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    type: "giveaway",
    amount: 1000000n,
    minPlayers: 1,
    maxPlayers: 2,
    timeoutSeconds: 600,
  }),
};
console.log(JSON.stringify(out, null, 1));
