import { address, createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { createLegacyTransaction, encodeTransactionBase64 } from "@timbagame/protocol/solana/plans";
import { GameCompletionTransactionBuilder } from "./src/game-completion-transaction-builder.ts";
const program = address("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5");
const operator = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(5));
const out = { operator: operator.address, cases: [] };
const mints = ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "So11111111111111111111111111111111111111112"];
for (const v of ["0.2.0", "0.3.0"]) {
  for (const [i, mint] of mints.entries()) {
    const builder = new GameCompletionTransactionBuilder({ programId: program, operator, contractVersion: v });
    const randomHash = new Uint8Array(32).fill(11 + i);
    const secretKey = new Uint8Array(32).fill(22 + i);
    const winner = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
    const creator = address("HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH");
    const ix = await builder.buildCompletionInstruction({
      gameAccount: { creator, tokenMint: address(mint) },
      winnerAddress: winner, randomHashBuffer: randomHash, secretKeyBuffer: secretKey, winnerIndex: 3 + i,
    });
    const tx = createLegacyTransaction(operator.address, { blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 1n }, [ix]);
    out.cases.push({ version: v, mint, randomHash: 11 + i, secretKey: 22 + i, winnerIndex: 3 + i, winner, creator, tx: encodeTransactionBase64(tx) });
  }
}
console.log(JSON.stringify(out, null, 1));
