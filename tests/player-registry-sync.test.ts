import { describe, it, expect } from "bun:test";
import type * as anchor from "./helpers/solana-fixtures.ts";
import { Keypair, PublicKey } from "./helpers/solana-fixtures.ts";
import {
  PlayerRegistrySync,
  type PlayerRegistrySyncOptions,
  type RegistryEvent,
} from "../player-registry-sync.ts";

type EventData = {
  name: string;
  data: Record<string, unknown>;
};

type SyncOverrides = {
  connection?: anchor.web3.Connection;
  parseEvents?: PlayerRegistrySyncOptions["parseEvents"];
} & Partial<Omit<PlayerRegistrySyncOptions, "connection" | "programId" | "parseEvents">>;

function createSync(
  eventsPerTransaction: Array<EventData[]>,
  overrides: SyncOverrides = {},
): PlayerRegistrySync {
  const programId = Keypair.generate().publicKey;
  const signatures = eventsPerTransaction.map(
    (_, index) => ({ signature: `sig-${index + 1}` }) as anchor.web3.ConfirmedSignatureInfo,
  );
  let signatureCalls = 0;
  let parseIndex = 0;

  const {
    connection: overrideConnection,
    parseEvents: overrideParser,
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

  const parseEvents =
    overrideParser ??
    (() =>
      (eventsPerTransaction[parseIndex++] ?? []).flatMap(({ name, data }): RegistryEvent[] => {
        const ticketIndex = Number(data["ticketIndex"]);
        if (!Number.isSafeInteger(ticketIndex) || ticketIndex < 0) return [];
        if (name === "playerUnjoined") {
          const movedParticipant = data["movedParticipant"];
          return [
            {
              kind: "unjoin",
              ticketIndex,
              ...(movedParticipant instanceof PublicKey
                ? { movedParticipant: movedParticipant.toBase58() }
                : {}),
            },
          ];
        }
        const player = data["player"];
        if (!(player instanceof PublicKey)) return [];
        return [{ kind: "join", ticketIndex, playerAddress: player.toBase58() }];
      }));

  return new PlayerRegistrySync({
    connection: connection as any,
    programId,
    parseEvents,
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

    expect(players).toEqual([playerOne.toBase58(), playerTwo.toBase58()]);
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
      [
        [
          {
            name: "playerJoined",
            data: {
              gameKey: gamePda,
              player,
              ticketIndex: 0,
            },
          },
        ],
      ],
      { connection },
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

  it("fetches each registry transaction without provider batch support", async () => {
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
            : ({
                meta: { logMessages: [`batched:${signature}`] },
              } as anchor.web3.TransactionResponse),
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
    });

    const players = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: 2,
    });

    expect(players).toEqual([playerOne.toBase58(), playerTwo.toBase58()]);
    expect(perSignatureFetches.sort()).toEqual(
      signatureInfos.map(({ signature }) => signature).sort(),
    );
    expect(batchedRequests).toHaveLength(0);
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
          () => ({ meta: { logMessages: ["chunk"] } }) as anchor.web3.TransactionResponse,
        );
        const delay = isFirstChunk ? 25 : 5;

        return new Promise<typeof responses>((resolve) => {
          setTimeout(() => resolve(responses), delay);
        });
      },
      async getTransaction(signature: string) {
        const delay = signature === "sig-0" ? 25 : 5;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return { meta: { logMessages: [signature] } };
      },
    } as unknown as anchor.web3.Connection;

    const sync = createSync(events, {
      connection,
      transactionConcurrency: 2,
      parseEvents: (_logs, transactionSignature) => {
        if (transactionSignature === "sig-2") {
          return [{ kind: "join", ticketIndex: 0, playerAddress: playerOne.toBase58() }];
        }
        if (transactionSignature === "sig-1") {
          return [{ kind: "unjoin", ticketIndex: 0 }];
        }
        return [{ kind: "join", ticketIndex: 0, playerAddress: playerTwo.toBase58() }];
      },
    });

    const players = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: 1,
    });

    expect(players).toEqual([playerTwo.toBase58()]);
  });

  it("does not require provider batch transaction support", async () => {
    const gamePda = Keypair.generate().publicKey;
    const players = Array.from({ length: 7 }, () => Keypair.generate().publicKey);

    const eventsPerTransaction: Array<EventData[]> = players.map((player, index) => [
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player,
          ticketIndex: index,
        },
      },
    ]);

    const signatureInfos: anchor.web3.ConfirmedSignatureInfo[] = eventsPerTransaction.map(
      (_events, index) => ({ signature: `sig-${index}` }) as anchor.web3.ConfirmedSignatureInfo,
    );
    let signaturePageCalls = 0;
    const batchedCalls: Array<string[]> = [];
    const perSignatureCalls: string[] = [];

    const connection = {
      async getSignaturesForAddress() {
        return signaturePageCalls++ === 0 ? signatureInfos : [];
      },
      async getTransactions(signatures: string[]) {
        batchedCalls.push(signatures);
        throw new Error(
          '403 Forbidden: {"jsonrpc":"2.0","error":{"code":-32403,"message":"Batch requests are only available for paid plans. Please upgrade if you would like to gain access"}}',
        );
      },
      async getTransaction(signature: string) {
        perSignatureCalls.push(signature);
        return {
          meta: { logMessages: [`single:${signature}`] },
        } as anchor.web3.TransactionResponse;
      },
    } as unknown as anchor.web3.Connection;

    const sync = createSync(eventsPerTransaction, {
      connection,
      transactionConcurrency: 1,
    });

    const recovered = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: players.length,
    });

    expect(recovered).toEqual(players.map((player) => player.toBase58()));
    expect(batchedCalls).toHaveLength(0);
    expect(perSignatureCalls).toHaveLength(players.length);
  });
});

describe("PlayerRegistrySync default event parsing", () => {
  it("rebuilds the registry from real program logs, including moved participants", async () => {
    const { programLogs, playerJoinedEvent, playerUnjoinedEvent } =
      await import("./helpers/program-events.ts");
    const programId = Keypair.generate().publicKey;
    const gamePda = Keypair.generate().publicKey;
    const first = Keypair.generate().publicKey.toBase58();
    const second = Keypair.generate().publicKey.toBase58();
    const third = Keypair.generate().publicKey.toBase58();
    const logsBySignature: Record<string, string[]> = {
      "sig-3": programLogs(programId.toBase58(), [
        playerJoinedEvent({ gameKey: gamePda.address, player: first as never, ticketIndex: 0 }),
        playerJoinedEvent({
          gameKey: gamePda.address,
          player: second as never,
          ticketIndex: 1,
          ticketsCount: 2,
        }),
      ]),
      "sig-2": programLogs(programId.toBase58(), [
        playerJoinedEvent({
          gameKey: gamePda.address,
          player: third as never,
          ticketIndex: 2,
          ticketsCount: 3,
        }),
      ]),
      "sig-1": programLogs(programId.toBase58(), [
        playerUnjoinedEvent({
          gameKey: gamePda.address,
          player: first as never,
          ticketIndex: 0,
          ticketsCount: 2,
          movedParticipant: third as never,
        }),
      ]),
    };
    let pages = 0;
    const connection = {
      async getSignaturesForAddress() {
        return pages++ === 0
          ? [{ signature: "sig-1" }, { signature: "sig-2" }, { signature: "sig-3" }]
          : [];
      },
      async getTransaction(signature: string) {
        return { meta: { logMessages: logsBySignature[signature] ?? null } };
      },
    };
    const sync = new PlayerRegistrySync({ connection: connection as any, programId });

    const players = await sync.fetchPlayersFromChain({ gamePda, expectedTickets: 2 });

    expect(players).toEqual([third, second]);
  });

  it("treats transactions without logs as carrying no registry events", async () => {
    const programId = Keypair.generate().publicKey;
    let pages = 0;
    const connection = {
      async getSignaturesForAddress() {
        return pages++ === 0 ? [{ signature: "sig-empty" }] : [];
      },
      async getTransaction() {
        return { meta: { logMessages: [] } };
      },
    };
    const sync = new PlayerRegistrySync({ connection: connection as any, programId });

    await expect(
      sync.fetchPlayersFromChain({ gamePda: Keypair.generate().publicKey, expectedTickets: 1 }),
    ).resolves.toBeNull();
  });
});
