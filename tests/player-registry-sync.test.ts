import { describe, it, expect } from "bun:test";
import type * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PlayerRegistrySync, type PlayerRegistrySyncOptions } from "../player-registry-sync.ts";

type EventData = {
  name: string;
  data: Record<string, unknown>;
};

type SyncOverrides = {
  connection?: anchor.web3.Connection;
  eventParserFactory?: PlayerRegistrySyncOptions["eventParserFactory"];
} & Partial<
    Omit<PlayerRegistrySyncOptions, "connection" | "program" | "eventParserFactory">
  >;

function createSync(
  eventsPerTransaction: Array<EventData[]>,
  overrides: SyncOverrides = {},
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

  const {
    connection: overrideConnection,
    eventParserFactory: overrideParser,
    ...restOverrides
  } = overrides;

  const connection =
    overrideConnection ??
    ({
      async getSignaturesForAddress(_address: PublicKey) {
        return signatureCalls++ === 0 ? signatures : [];
      },
      async getTransaction(_signature: string) {
        return { meta: { logMessages: ["dummy"] } } as const;
      },
    } as unknown as anchor.web3.Connection);

  const eventParserFactory =
    overrideParser ??
    (() => ({
      parseLogs: () => eventsPerTransaction[parseIndex++] ?? [],
    }));

  return new PlayerRegistrySync({
    connection,
    program: program as unknown as anchor.Program<any>,
    eventParserFactory,
    ...restOverrides,
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

  it("never requests zero signatures when expectedTickets is specified", async () => {
    const gamePda = Keypair.generate().publicKey;
    const player = Keypair.generate().publicKey;
    const requestedLimits: number[] = [];

    const connection = {
      async getSignaturesForAddress(_address: PublicKey, config?: { limit?: number }) {
        requestedLimits.push(config?.limit ?? 0);
        return [{ signature: "sig-1" } as anchor.web3.ConfirmedSignatureInfo];
      },
      async getTransaction() {
        return { meta: { logMessages: ["dummy"] } } as const;
      },
    } as unknown as anchor.web3.Connection;

    const sync = createSync(
      [[
        {
          name: "playerJoined",
          data: {
            gameKey: gamePda,
            player,
            ticketIndex: 0,
          },
        },
      ]],
      { connection }
    );

    const players = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: 1,
    });

    expect(players).toEqual([player.toBase58()]);
    expect(requestedLimits.every((limit) => limit > 0)).toBe(true);
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

  it("requests versioned transactions when fetching registry events", async () => {
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
    expect(receivedMaxVersion).toBe(0);
  });

  it("refetches missing transactions when batch responses contain null entries", async () => {
    const gamePda = Keypair.generate().publicKey;
    const playerOne = Keypair.generate().publicKey;
    const playerTwo = Keypair.generate().publicKey;

    const events: Array<EventData[]> = [
      [
        {
          name: "playerJoined",
          data: {
            gameKey: gamePda,
            player: playerOne,
            ticketIndex: 0,
          },
        },
      ],
      [
        {
          name: "playerJoined",
          data: {
            gameKey: gamePda,
            player: playerTwo,
            ticketIndex: 1,
          },
        },
      ],
    ];

    const signatureInfos: anchor.web3.ConfirmedSignatureInfo[] = [
      { signature: "sig-a" } as anchor.web3.ConfirmedSignatureInfo,
      { signature: "sig-b" } as anchor.web3.ConfirmedSignatureInfo,
    ];
    const missingSignature = signatureInfos[1]!.signature;

    let signaturePageCalls = 0;
    const perSignatureFetches: string[] = [];
    const batchedRequests: Array<string[]> = [];

    const connection = {
      async getSignaturesForAddress() {
        return signaturePageCalls++ === 0 ? signatureInfos : [];
      },
      async getTransactions(signatures: string[]) {
        batchedRequests.push(signatures);
        return signatures.map((signature) =>
          signature === missingSignature
            ? null
            : ({ meta: { logMessages: [`batched:${signature}`] } } as anchor.web3.TransactionResponse),
        );
      },
      async getTransaction(signature: string) {
        perSignatureFetches.push(signature);
        return {
          meta: { logMessages: [`single:${signature}`] },
        } as anchor.web3.TransactionResponse;
      },
    } as unknown as anchor.web3.Connection;

    const sync = createSync(events, {
      connection,
      transactionBatchSize: 2,
    });

    const players = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: 2,
    });

    expect(players).toEqual([playerOne.toBase58(), playerTwo.toBase58()]);
    expect(perSignatureFetches).toEqual([missingSignature]);
    expect(batchedRequests).toHaveLength(1);
  });

  it("applies chunk results sequentially even when completion order differs", async () => {
    const gamePda = Keypair.generate().publicKey;
    const playerOne = Keypair.generate().publicKey;
    const playerTwo = Keypair.generate().publicKey;

    const events: Array<EventData[]> = [
      [
        {
          name: "playerJoined",
          data: {
            gameKey: gamePda,
            player: playerOne,
            ticketIndex: 0,
          },
        },
      ],
      [
        {
          name: "playerUnjoined",
          data: {
            gameKey: gamePda,
            ticketIndex: 0,
          },
        },
      ],
      [
        {
          name: "playerJoined",
          data: {
            gameKey: gamePda,
            player: playerTwo,
            ticketIndex: 0,
          },
        },
      ],
    ];

    const signatureInfos: anchor.web3.ConfirmedSignatureInfo[] = [
      { signature: "sig-0" } as anchor.web3.ConfirmedSignatureInfo,
      { signature: "sig-1" } as anchor.web3.ConfirmedSignatureInfo,
      { signature: "sig-2" } as anchor.web3.ConfirmedSignatureInfo,
    ];

    let signaturePageCalls = 0;

    const connection = {
      async getSignaturesForAddress() {
        return signaturePageCalls++ === 0 ? signatureInfos : [];
      },
      async getTransactions(signatures: string[]) {
        const isFirstChunk = signatures.includes("sig-0");
        const responses = signatures.map(
          () => ({ meta: { logMessages: ["chunk"] } } as anchor.web3.TransactionResponse),
        );
        const delay = isFirstChunk ? 25 : 5;

        return new Promise<typeof responses>((resolve) => {
          setTimeout(() => resolve(responses), delay);
        });
      },
      async getTransaction(signature: string) {
        throw new Error(`unexpected per-signature fetch ${signature}`);
      },
    } as unknown as anchor.web3.Connection;

    const sync = createSync(events, {
      connection,
      transactionBatchSize: 2,
      transactionConcurrency: 2,
    });

    const players = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: 1,
    });

    expect(players).toEqual([playerTwo.toBase58()]);
  });
});
