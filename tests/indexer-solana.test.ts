import { describe, expect, test } from "bun:test";
import { Keypair } from "./helpers/solana-fixtures.ts";
import { getTrustedProgramData, parseTransactionEvents } from "../indexer/solana.ts";

function initializedEvent(): Buffer {
  const data = Buffer.alloc(146);
  Buffer.from([82, 221, 11, 2, 244, 52, 240, 250]).copy(data);
  Keypair.generate().publicKey.toBuffer().copy(data, 8);
  Keypair.generate().publicKey.toBuffer().copy(data, 40);
  data.writeUInt8(0, 72);
  data.writeBigUInt64LE(100n, 73);
  data.writeBigUInt64LE(100n, 81);
  data.writeUInt32LE(2, 89);
  data.writeUInt32LE(2, 93);
  Keypair.generate().publicKey.toBuffer().copy(data, 97);
  data.writeUInt8(0, 129);
  data.writeBigUInt64LE(1_000n, 130);
  data.writeBigUInt64LE(3_600n, 138);
  return data;
}

describe("Solana indexer log parsing", () => {
  test("accepts only events emitted in the Timba invocation frame", () => {
    const program = Keypair.generate().publicKey.toBase58();
    const attacker = Keypair.generate().publicKey.toBase58();
    const encoded = initializedEvent().toString("base64");
    const logs = [
      `Program ${program} invoke [1]`,
      `Program data: ${encoded}`,
      `Program ${attacker} invoke [2]`,
      `Program data: ${encoded}`,
      `Program ${attacker} success`,
      `Program ${program} success`,
    ];

    expect(getTrustedProgramData(logs, program)).toHaveLength(1);
    expect(parseTransactionEvents("1".repeat(64), 10, logs, program).initialized).toHaveLength(1);
  });

  test("maps the v0.3 operator closure event to a cancelled lifecycle event", () => {
    const program = Keypair.generate().publicKey.toBase58();
    const data = Buffer.alloc(128);
    Buffer.from([236, 51, 251, 125, 251, 64, 187, 174]).copy(data);
    const game = Keypair.generate().publicKey;
    game.toBuffer().copy(data, 8);
    Keypair.generate().publicKey.toBuffer().copy(data, 40);
    Keypair.generate().publicKey.toBuffer().copy(data, 72);
    data.writeBigUInt64LE(100n, 104);
    data.writeBigUInt64LE(200n, 112);
    data.writeBigUInt64LE(1_000n, 120);

    const events = parseTransactionEvents(
      "1".repeat(64),
      10,
      [`Program ${program} invoke [1]`, `Program data: ${data.toString("base64")}`],
      program,
    );
    expect(events.closed).toEqual([
      {
        signature: "1".repeat(64),
        slot: 10,
        gameKey: game.toBase58(),
        timestamp: 1_000,
        operator: true,
      },
    ]);
  });
});
