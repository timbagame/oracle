import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { IndexerDatabase } from "../indexer/database.ts";

const databases: IndexerDatabase[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  for (const database of databases.splice(0)) database.close();
});

function open(): IndexerDatabase {
  const database = new IndexerDatabase(":memory:");
  databases.push(database);
  return database;
}

function freezeClock(start: number) {
  let now = start;
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  restores.push(() => spy.mockRestore());
  return {
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("IndexerDatabase verification jobs", () => {
  test("delays a queued verification by one minute", () => {
    const database = open();
    const clock = freezeClock(1_000_000);

    database.queueVerification("sig-a");
    expect(database.nextVerificationJob()).toBeNull();
    clock.advance(60_000);

    expect(database.nextVerificationJob()).toEqual({ signature: "sig-a", attempts: 0 });
  });

  test("does not queue the same signature twice", () => {
    const database = open();
    const clock = freezeClock(1_000_000);

    database.queueVerification("sig-a");
    clock.advance(30_000);
    database.queueVerification("sig-a");
    clock.advance(30_000);

    expect(database.nextVerificationJob()).toEqual({ signature: "sig-a", attempts: 0 });
  });

  test("backs off retries exponentially and caps them at one day", () => {
    const database = open();
    const clock = freezeClock(1_000_000);
    database.queueVerification("sig-a");
    clock.advance(60_000);

    database.retryVerificationJob("sig-a", 2);
    clock.advance(4 * 60_000 - 1);
    expect(database.nextVerificationJob()).toBeNull();
    clock.advance(1);
    expect(database.nextVerificationJob()).toEqual({ signature: "sig-a", attempts: 3 });

    database.retryVerificationJob("sig-a", 20);
    clock.advance(86_400_000 - 1);
    expect(database.nextVerificationJob()).toBeNull();
    clock.advance(1);
    expect(database.nextVerificationJob()).toEqual({ signature: "sig-a", attempts: 21 });
  });

  test("removes finished jobs", () => {
    const database = open();
    const clock = freezeClock(1_000_000);
    database.queueVerification("sig-a");
    clock.advance(60_000);

    database.finishVerificationJob("sig-a");

    expect(database.nextVerificationJob()).toBeNull();
  });

  test("caches verified game payloads by key", () => {
    const database = open();

    expect(database.getVerifiedGame("game:1")).toBeNull();
    database.saveVerifiedGame("game:1", '{"ok":true}');
    database.saveVerifiedGame("game:1", '{"ok":false}');

    expect(database.getVerifiedGame("game:1")).toBe('{"ok":false}');
  });
});

describe("IndexerDatabase historical backfill state", () => {
  test("reports an empty backfill before any import", () => {
    expect(open().getBackfillState()).toEqual({
      beforeSignature: null,
      pages: 0,
      transactions: 0,
      initializedEvents: 0,
      closedEvents: 0,
      complete: false,
    });
  });

  test("reports imported backfill progress", () => {
    const database = open();
    database.importSql(`INSERT INTO historical_backfill
      (name, before_signature, pages, transactions, initialized_events, closed_events, complete, updated_at)
      VALUES ('game-lifecycle-v3-player-history', 'sig-before', 3, 250, 40, 7, 1, 1)`);

    expect(database.getBackfillState()).toEqual({
      beforeSignature: "sig-before",
      pages: 3,
      transactions: 250,
      initializedEvents: 40,
      closedEvents: 7,
      complete: true,
    });
  });
});
