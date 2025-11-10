import { describe, it, expect } from "bun:test";
import type * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PlayerRegistrySync, type PlayerRegistrySyncOptions } from "../player-registry-sync.ts";

type EventData = {
  name: string;
  data: Record<string, unknown>;
};

function createSync(
  eventsPerTransaction: Array<EventData[]>,
  overrides: {
    connection?: anchor.web3.Connection;
    eventParserFactory?: PlayerRegistrySyncOptions["eventParserFactory"];
  } = {},
): PlayerRegistrySync {
  const programId = Keypair.generate().publicKey;
  const program = {
    programId,
    coder: {},
    idl: {},
  } as const;

  const signatures = eventsPerTransaction.map(
    (_, index) => ({ signature: `sig-${index + 1}` } as anchor.web3.ConfirmedSignatureInfo),
  );
  let signatureCalls = 0;
  let parseIndex = 0;

  const connection =
    overrides.connection ??
    ({
      async getSignaturesForAddress(_address: PublicKey) {
        return signatureCalls++ === 0 ? signatures : [];
      },
      async getTransaction(_signature: string) {
        return { meta: { logMessages: ["dummy"] } } as const;
      },
    } as unknown as anchor.web3.Connection);

  const eventParserFactory =
    overrides.eventParserFactory ??
    (() => ({
      parseLogs: () => eventsPerTransaction[parseIndex++] ?? [],
    }));

  return new PlayerRegistrySync({
    connection,
    program: program as unknown as anchor.Program<any>,
    eventParserFactory,
  });
}

describe("PlayerRegistrySync", () => {
  it("recovers players when ticket indexes start at one", async () => {
    const gamePda = Keypair.generate().publicKey;
    const playerOne = Keypair.generate().publicKey;
    const playerTwo = Keypair.generate().publicKey;

    const events: EventData[] = [
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player: playerOne,
          ticketIndex: 1,
        },
      },
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player: playerTwo,
          ticketIndex: 2,
        },
      },
    ];

    const sync = createSync([events]);

    const players = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: 2,
    });

    expect(players).toEqual([
      playerOne.toBase58(),
      playerTwo.toBase58(),
    ]);
  });

  it("rejects registries with index gaps", async () => {
    const gamePda = Keypair.generate().publicKey;
    const playerOne = Keypair.generate().publicKey;
    const playerTwo = Keypair.generate().publicKey;

    const events: EventData[] = [
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player: playerOne,
          ticketIndex: 1,
        },
      },
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player: playerTwo,
          ticketIndex: 3,
        },
      },
    ];

    const sync = createSync([events]);

    const players = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: 2,
    });

    expect(players).toBeNull();
  });

  it("rejects registries that contain duplicate ticket indexes", async () => {
    const gamePda = Keypair.generate().publicKey;
    const playerOne = Keypair.generate().publicKey;
    const playerTwo = Keypair.generate().publicKey;

    const events: EventData[] = [
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player: playerOne,
          ticketIndex: 0,
        },
      },
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player: playerTwo,
          ticketIndex: 0,
        },
      },
    ];

    const sync = createSync([events]);

    const players = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: 2,
    });

    expect(players).toBeNull();
  });

  it("applies playerUnjoined events after the registry initially looks satisfied", async () => {
    const gamePda = Keypair.generate().publicKey;
    const playerOne = Keypair.generate().publicKey;
    const playerTwo = Keypair.generate().publicKey;

    const firstSignatureEvents: EventData[] = [
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player: playerOne,
          ticketIndex: 0,
        },
      },
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player: playerTwo,
          ticketIndex: 1,
        },
      },
    ];

    const secondSignatureEvents: EventData[] = [
      {
        name: "playerUnjoined",
        data: {
          gameKey: gamePda,
          ticketIndex: 0,
        },
      },
    ];

    const sync = createSync([firstSignatureEvents, secondSignatureEvents]);

    const players = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: 2,
    });

    expect(players).toEqual([playerTwo.toBase58()]);
  });

  it("ignores negative ticket indexes in parsed events", async () => {
    const gamePda = Keypair.generate().publicKey;
    const player = Keypair.generate().publicKey;

    const events: EventData[] = [
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player,
          ticketIndex: -1,
        },
      },
    ];

    const sync = createSync([events]);

    const players = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: 1,
    });

    expect(players).toBeNull();
  });

  it("tolerates invalid player public keys without aborting the sync", async () => {
    const gamePda = Keypair.generate().publicKey;

    const events: EventData[] = [
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player: "not-a-base58-key!",
          ticketIndex: 0,
        },
      },
    ];

    const sync = createSync([events]);

    const players = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: 1,
    });

    expect(players).toBeNull();
  });

  it("honors maxSignatures limits when paging signatures", async () => {
    const gamePda = Keypair.generate().publicKey;
    const player = Keypair.generate().publicKey;

    let callCount = 0;
    const requestedLimits: Array<number | undefined> = [];

    const connection = {
      async getSignaturesForAddress(_address: PublicKey, config?: { limit?: number }) {
        callCount++;
        requestedLimits.push(config?.limit);
        if (callCount > 1) {
          throw new Error("Should not request additional signature pages");
        }
        return [{ signature: "sig-1" } as anchor.web3.ConfirmedSignatureInfo];
      },
      async getTransaction(_signature: string) {
        return { meta: { logMessages: ["dummy"] } } as const;
      },
    } as unknown as anchor.web3.Connection;

    const events: EventData[] = [
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player,
          ticketIndex: 0,
        },
      },
    ];

    const sync = createSync([events], { connection });

    const players = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: 1,
      maxSignatures: 1,
    });

    expect(players).toEqual([player.toBase58()]);
    expect(callCount).toBe(1);
    expect(requestedLimits).toEqual([1]);
  });

  it("processes versioned transactions without forcing legacy-only lookups", async () => {
    const gamePda = Keypair.generate().publicKey;
    const player = Keypair.generate().publicKey;

    const events: EventData[] = [
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player,
          ticketIndex: 0,
        },
      },
    ];

    const signatures = [{ signature: "sig-v1" }];
    let calls = 0;
    let receivedMaxVersion: number | undefined;

    const connection = {
      async getSignaturesForAddress() {
        return calls++ === 0 ? signatures : [];
      },
      async getTransaction(_signature: string, opts?: { maxSupportedTransactionVersion?: number }) {
        receivedMaxVersion = opts?.maxSupportedTransactionVersion;
        return {
          version: 1,
          meta: { logMessages: ["dummy"] },
        } as const;
      },
    } as unknown as anchor.web3.Connection;

    const sync = createSync([events], { connection });

    const players = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: 1,
    });

    expect(players).toEqual([player.toBase58()]);
    expect(receivedMaxVersion).toBeUndefined();
  });
});
