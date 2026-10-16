import { buildCreateGamePlan, createLegacyTransaction, createContractAdapter, encodeTransactionBase64 } from "@timbagame/protocol/solana/plans";
import { address } from "@solana/kit";
const program = address("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5");
const creator = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const operator = address("HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH");
const mint = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const out = {};
for (const v of ["0.2.0","0.3.0"]) {
  const plan = await buildCreateGamePlan({creator, tokenMint: mint, type:"giveaway", amount: 123456789n, minPlayers: 2, maxPlayers: 10, timeoutSeconds: 3600n, randomHash: new Uint8Array(32).fill(7), oracleOperator: operator}, v, program);
  const tx = createLegacyTransaction(creator, {blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 1n}, plan.instructions);
  const adapter = createContractAdapter(v, program);
  const join = await adapter.buildJoinPlan({game: plan.game, player: operator, tokenMint: address("So11111111111111111111111111111111111111112"), tokenAmount: 5000n});
  const jtx = createLegacyTransaction(operator, {blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 1n}, join.instructions);
  const unjoin = await adapter.buildUnjoinPlan({game: plan.game, player: operator, tokenMint: mint, authority: creator});
  const utx = createLegacyTransaction(creator, {blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 1n}, unjoin.instructions);
  const close = await adapter.buildClosePlan({game: plan.game, creator, tokenMint: mint});
  const ctx = createLegacyTransaction(creator, {blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 1n}, close.instructions);
  out[v] = { game: plan.game, create: encodeTransactionBase64(tx), join: encodeTransactionBase64(jtx), unjoin: encodeTransactionBase64(utx), close: encodeTransactionBase64(ctx) };
}
console.log(JSON.stringify(out, null, 1));
