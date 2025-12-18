import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { coercePublicKey } from "../solana-utils.ts";
import { OracleEventProcessor, type OracleEventProcessorOptions, EVENT_HANDLER_CONFIG } from "../oracle-event-processor.ts";
import { type OracleDatabase } from "../database.ts";
import {
  createProgramStub,
  type ProgramStub,
} from "./helpers/program-stub.ts";
import { setupOracleServiceEnv } from "./helpers/setup-oracle-service-env.ts";

type OracleServiceType = import("../oracle-service.ts").OracleService;
type OracleServiceClass = typeof import("../oracle-service.ts").OracleService;

let OracleServiceClass: OracleServiceClass;
let cleanup: () => void;

beforeAll(async () => {
  const env = await setupOracleServiceEnv("oracle-service-events-test");
  OracleServiceClass = env.OracleService;
  cleanup = env.cleanup;
});

afterAll(() => {
  cleanup();
});

const seedSecretForGame = (
  db: { saveSecretKey: (game: string, secretKey: string, randomHash: string) => void },
  gameAddress: string,
) => {
  db.saveSecretKey(gameAddress, "00".repeat(32), "11".repeat(32));
};

describe("OracleService event handling", () => {
  it("ignores game initialization events for games without oracle secrets", () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const gameKey = Keypair.generate().publicKey;
    service.events.handleGameInitialized({
      gameKey,
      gameType: { coinflip: {} },
    });

    expect(callLog.track).toEqual([]);
  });

  it("ignores player events for games without oracle secrets", async () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const autoCompleteCalls: string[] = [];
    const service = createService(db, programStub, {
      tryAutoComplete: async (_gameKey: any, gameAddress: string) => {
        autoCompleteCalls.push(gameAddress);
      },
    });

    const gameKey = Keypair.generate().publicKey;
    const playerKey = Keypair.generate().publicKey;

    await service.events.handlePlayerEvent("joined", {
      gameKey,
      player: playerKey,
      ticketIndex: 1,
    });

    expect(callLog.addPlayer).toEqual([]);
    expect(autoCompleteCalls).toEqual([]);
  });

  it("registers and cleans up event listeners", async () => {
    const { db } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    await service.startEventListening();
    expect(programStub.addCalls.map((call) => call.event)).toEqual(
      OracleServiceClass.EVENT_HANDLER_CONFIG.map(
        (definition) => definition.event
      )
    );

    const statsWhileListening = service.getStats();
    expect(statsWhileListening.eventListening).toBe(true);
    expect(service.events.isListening()).toBe(true);
    expect(service.events.getActiveListenerCount()).toBe(
      OracleServiceClass.EVENT_HANDLER_CONFIG.length
    );

    await service.startEventListening();
    expect(programStub.addCalls.length).toBe(5);

    await service.stopEventListening();
    expect(programStub.removeCalls).toEqual([1, 2, 3, 4, 5]);

    const statsAfterStop = service.getStats();
    expect(statsAfterStop.eventListening).toBe(false);
    expect(service.events.isListening()).toBe(false);
    expect(service.events.getActiveListenerCount()).toBe(0);
  });

  it("awaits asynchronous event listener registration", async () => {
    const { db } = createDbStub();
    const programStub = createProgramStub({ asyncRegistration: true });
    const service = createService(db, programStub);

    await service.startEventListening();
    expect(service.events.getActiveListenerCount()).toBe(
      EVENT_HANDLER_CONFIG.length
    );

    await service.stopEventListening();
    expect(programStub.removeCalls).toEqual([1, 2, 3, 4, 5]);
  });

  it("deduplicates concurrent listener startups", async () => {
    const { db } = createDbStub();
    const programStub = createProgramStub({ asyncRegistration: true });
    const service = createService(db, programStub);

    await Promise.all([
      service.startEventListening(),
      service.startEventListening(),
    ]);

    expect(programStub.addCalls).toHaveLength(
      EVENT_HANDLER_CONFIG.length
    );
    expect(service.events.getActiveListenerCount()).toBe(
      EVENT_HANDLER_CONFIG.length
    );

    await service.stopEventListening();
  });

  it("prevents OracleEventProcessor from registering duplicate listeners when started concurrently", async () => {
    const { db } = createDbStub();
    const programStub = createProgramStub({ asyncRegistration: true });
    const service = createService(db, programStub);
    const processor = service.events;

    await Promise.all([processor.startListening(), processor.startListening()]);

    expect(programStub.addCalls).toHaveLength(
      EVENT_HANDLER_CONFIG.length,
    );
    expect(processor.getActiveListenerCount()).toBe(
      EVENT_HANDLER_CONFIG.length,
    );

    await processor.stopListening();
  });

  it("processes player join and unjoin events", async () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const autoCompleteCalls: Array<[PublicKey, string, string]> = [];
    const service = createService(db, programStub, {
      tryAutoComplete: async (...args: [any, any, any]) => {
        autoCompleteCalls.push(args as [PublicKey, string, string]);
      },
    });

    const gameKey = Keypair.generate().publicKey;
    seedSecretForGame(db, gameKey.toBase58());
    const playerKey = Keypair.generate().publicKey;

    await service.events.handlePlayerEvent("joined", {
      gameKey,
      player: playerKey,
      ticketIndex: 7,
    });

    expect(callLog.addPlayer).toEqual([
      { game: gameKey.toBase58(), player: playerKey.toBase58(), index: 7 },
    ]);
    expect(autoCompleteCalls).toHaveLength(1);
    const firstCall = autoCompleteCalls[0];
    if (!firstCall) {
      throw new Error("expected first auto-complete invocation");
    }
    const [firstPda, firstAddress, firstTrigger] = firstCall;
    expect(firstPda.equals(gameKey)).toBe(true);
    expect(firstAddress).toBe(gameKey.toBase58());
    expect(firstTrigger).toBe("joined");

    await service.events.handlePlayerEvent("unjoined", {
      gameKey,
      player: playerKey,
      ticketIndex: 7,
    });

    expect(callLog.removePlayer).toEqual([
      { game: gameKey.toBase58(), index: 7 },
    ]);
    expect(autoCompleteCalls).toHaveLength(2);
    const secondCall = autoCompleteCalls[1];
    if (!secondCall) {
      throw new Error("expected second auto-complete invocation");
    }
    const [, , secondTrigger] = secondCall;
    expect(secondTrigger).toBe("unjoined");
  });

  it("batches high-volume player events into a single auto-complete attempt", async () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const autoCompleteCalls: Array<{ game: string; trigger: string }> = [];
    const service = createService(db, programStub, {
      playerEventFlushDebounceMs: 10,
      autoCompleteDebounceMs: 10,
      tryAutoComplete: async (_gameKey: any, gameAddress: string, trigger: string) => {
        autoCompleteCalls.push({ game: gameAddress, trigger });
      },
    });

    const gameKey = Keypair.generate().publicKey;
    seedSecretForGame(db, gameKey.toBase58());

    const players = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];

    await Promise.all(
      players.map((player, index) =>
        service.events.handlePlayerEvent("joined", {
          gameKey,
          player,
          ticketIndex: index,
          ticketsCount: index + 1,
        } as any)
      )
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(callLog.addPlayer).toHaveLength(3);
    expect(autoCompleteCalls).toHaveLength(1);
    expect(autoCompleteCalls[0]?.game).toBe(gameKey.toBase58());
  });

  it("applies player mutation batches via db.applyPlayerMutations with correct this binding", async () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub, {
      playerEventFlushDebounceMs: 0,
      autoCompleteDebounceMs: 0,
    });

    (db as any).marker = "bound";
    (db as any).applyPlayerMutations = function (
      game: string,
      operations: ReadonlyArray<{ action: "joined"; playerAddress: string; ticketIndex: number } | { action: "unjoined"; ticketIndex: number }>,
    ) {
      if ((this as any).marker !== "bound") {
        throw new Error("applyPlayerMutations lost this binding");
      }
      for (const op of operations) {
        if (op.action === "joined") {
          this.addPlayerToGame(game, op.playerAddress, op.ticketIndex);
        } else {
          this.removePlayerFromGame(game, op.ticketIndex);
        }
      }
    };

    const gameKey = Keypair.generate().publicKey;
    seedSecretForGame(db, gameKey.toBase58());
    const playerKey = Keypair.generate().publicKey;

    await expect(
      service.events.handlePlayerEvent("joined", {
        gameKey,
        player: playerKey,
        ticketIndex: 1,
        ticketsCount: 1,
      } as any),
    ).resolves.toBeUndefined();

    expect(callLog.addPlayer).toEqual([
      { game: gameKey.toBase58(), player: playerKey.toBase58(), index: 1 },
    ]);
  });

  it("flushes pending player batches before processing status events", async () => {
    const { db } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub, {
      playerEventFlushDebounceMs: 50,
      autoCompleteDebounceMs: 0,
    });

    const ordered: string[] = [];

    const origAddPlayer = db.addPlayerToGame;
    db.addPlayerToGame = (game, player, index) => {
      ordered.push("player");
      return origAddPlayer(game, player, index);
    };

    const origMarkClosed = db.markGameClosed;
    db.markGameClosed = (game) => {
      ordered.push("closed");
      return origMarkClosed(game);
    };

    const origClearPlayers = db.clearStalePlayersForGame;
    db.clearStalePlayersForGame = (game) => {
      ordered.push("cleared");
      return origClearPlayers(game);
    };

    const gameKey = Keypair.generate().publicKey;
    seedSecretForGame(db, gameKey.toBase58());
    const playerKey = Keypair.generate().publicKey;

    await service.events.handlePlayerEvent("joined", {
      gameKey,
      player: playerKey,
      ticketIndex: 1,
      ticketsCount: 1,
    } as any);

    service.events.handleGameStatusChange("closed", { gameKey } as any);

    const queues: Map<string, Promise<void>> = (service.events as any).processingQueues;
    await Promise.all(Array.from(queues.values()));

    expect(ordered).toEqual(["player", "closed", "cleared"]);
  });

  it("requests registry reconciliation when ticket indexes skip", async () => {
    const { db } = createDbStub();
    const programStub = createProgramStub();
    const syncCalls: Array<{ gameAddress: string; expectedTickets?: number; trigger: string }> = [];
    const service = createService(db, programStub, {
      syncPlayerRegistry: async (options: any) => {
        syncCalls.push({
          gameAddress: options.gameAddress,
          expectedTickets: options.expectedTickets,
          trigger: options.trigger,
        });
        return true;
      },
    });

    const gameKey = Keypair.generate().publicKey;
    seedSecretForGame(db, gameKey.toBase58());
    const playerKey = Keypair.generate().publicKey;

    await service.events.handlePlayerEvent("joined", {
      gameKey,
      player: playerKey,
      ticketIndex: 2,
      ticketsCount: 3,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(syncCalls).toEqual([
      {
        gameAddress: gameKey.toBase58(),
        expectedTickets: 3,
        trigger: "player joined",
      },
    ]);
  });

  it("deduplicates registry sync scheduling while an earlier run is pending", async () => {
    const { db } = createDbStub();
    const programStub = createProgramStub();
    let resolveSync: (value: boolean) => void = () => {};
    let syncCount = 0;

    const service = createService(db, programStub, {
      syncPlayerRegistry: async () => {
        syncCount++;
        return new Promise<boolean>((resolve) => {
          resolveSync = resolve;
        });
      },
    });

    const gameKey = Keypair.generate().publicKey;
    seedSecretForGame(db, gameKey.toBase58());
    const playerKey = Keypair.generate().publicKey;

    const first = service.events.handlePlayerEvent("joined", {
      gameKey,
      player: playerKey,
      ticketIndex: 2,
      ticketsCount: 3,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = service.events.handlePlayerEvent("joined", {
      gameKey,
      player: playerKey,
      ticketIndex: 2,
      ticketsCount: 3,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncCount).toBe(1);

    resolveSync(true);
    await Promise.all([first, second]);

    // Should still be 1 because second request was deduplicated/merged into pending retry or queue?
    // Wait, if first succeeds, second should run if it was queued.
    // But here we are testing deduplication of SCHEDULING.
    // If sync is running, second request is queued.
    // When first finishes, it processes queue.
    // So it runs twice.
    // But the test name says "deduplicates".
    // Maybe it means "does not start parallel sync"?
    // Yes, syncCount is 1 WHILE first is pending.
    // After first resolves, it becomes 2.

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncCount).toBe(2);
  });

  it("throttles player registry sync retries after repeated failures", async () => {
    const { db } = createDbStub();
    const programStub = createProgramStub();

    const retryDelayMs = 25;
    const timers: Array<{ id: number; callback: () => void; delay: number }> = [];
    let nextTimerId = 1;

    const setTimeoutStub: typeof setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
      const id = nextTimerId++;
      timers.push({ id, callback: callback as () => void, delay: Number(delay ?? 0) });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const clearTimeoutStub: typeof clearTimeout = (id) => {
      const numericId = Number(id);
      const index = timers.findIndex((timer) => timer.id === numericId);
      if (index >= 0) {
        timers.splice(index, 1);
      }
    };

    const outcomes = [false, false, true];
    const syncCalls: Array<{ attempt: number; trigger: string }> = [];

    const processor = new OracleEventProcessor({
      getProgram: () => programStub as any,
      db: db as any,
      tryAutoComplete: async () => {},
      config: EVENT_HANDLER_CONFIG,
      clearTokenProgramCache: () => {},
      syncPlayerRegistry: async (options) => {
        const attempt = syncCalls.length + 1;
        syncCalls.push({ attempt, trigger: options.trigger });
        return outcomes[attempt - 1] ?? true;
      },
      setTimeoutFn: setTimeoutStub,
      clearTimeoutFn: clearTimeoutStub,
      registrySyncRetryDelayMs: retryDelayMs,
      registrySyncTimeoutMs: 0,
    });

    const gameAddress = "game-retry";

    await (processor as any).schedulePlayerRegistrySync({
      gameAddress,
      trigger: "initial",
    });

    expect(syncCalls).toHaveLength(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delay).toBe(retryDelayMs);

    const firstTimer = timers.shift();
    firstTimer?.callback();
    await Promise.resolve();

    expect(syncCalls).toHaveLength(2);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delay).toBe(retryDelayMs);

    const secondTimer = timers.shift();
    secondTimer?.callback();
    await Promise.resolve();

    expect(syncCalls).toHaveLength(3);
    expect(timers).toHaveLength(0);
    expect(
      (processor as any).registrySyncScheduler?.hasPendingEntry(gameAddress),
    ).toBe(false);
  });

  it("ignores player events with missing data", async () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    (service as any).tryAutoComplete = async () => {
      throw new Error("should not be called");
    };

    const gameKey = Keypair.generate().publicKey;

    await service.events.handlePlayerEvent("joined", {
      gameKey,
      ticketIndex: 3,
    });

    await service.events.handlePlayerEvent("joined", {
      gameKey,
      player: Keypair.generate().publicKey,
    });

    await service.events.handlePlayerEvent("unjoined", {
      gameKey,
      player: Keypair.generate().publicKey,
    });

    expect(callLog.addPlayer).toEqual([]);
    expect(callLog.removePlayer).toEqual([]);
  });

  it("rejects player events with negative ticket indexes", async () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const autoCompleteCalls: string[] = [];
    (service as any).tryAutoComplete = async (_gameKey: PublicKey, gameAddress: string) => {
      autoCompleteCalls.push(gameAddress);
    };

    const gameKey = Keypair.generate().publicKey;
    seedSecretForGame(db, gameKey.toBase58());
    const playerKey = Keypair.generate().publicKey;

    await service.events.handlePlayerEvent("joined", {
      gameKey,
      player: playerKey,
      ticketIndex: -5,
    });

    expect(callLog.addPlayer).toEqual([]);
    expect(autoCompleteCalls).toHaveLength(0);
  });

  it("rejects player events with oversized ticket indexes", async () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const autoCompleteCalls: string[] = [];
    (service as any).tryAutoComplete = async (_gameKey: PublicKey, gameAddress: string) => {
      autoCompleteCalls.push(gameAddress);
    };

    const gameKey = Keypair.generate().publicKey;
    seedSecretForGame(db, gameKey.toBase58());
    const playerKey = Keypair.generate().publicKey;

    await service.events.handlePlayerEvent("joined", {
      gameKey,
      player: playerKey,
      ticketIndex: (BigInt(Number.MAX_SAFE_INTEGER) + 10n),
    });

    expect(callLog.addPlayer).toEqual([]);
    expect(autoCompleteCalls).toHaveLength(0);
  });

  it("ignores player events with invalid game addresses", async () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    (service as any).tryAutoComplete = async () => {
      throw new Error("should not attempt auto-complete");
    };

    const player = Keypair.generate().publicKey;

    await expect(
      service.events.handlePlayerEvent("joined", {
        gameKey: "@@invalid@@",
        player,
        ticketIndex: 1,
      }),
    ).resolves.toBeUndefined();

    expect(callLog.addPlayer).toEqual([]);
  });

  it("updates game status in response to events", async () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const gameKey = Keypair.generate().publicKey;
    seedSecretForGame(db, gameKey.toBase58());

    service.events.handleGameStatusChange("completed", { gameKey });
    service.events.handleGameStatusChange("closed", { gameKey });

    expect(callLog.markCompleted).toEqual([gameKey.toBase58()]);
    expect(callLog.markClosed).toEqual([gameKey.toBase58()]);
    expect(callLog.clearPlayers).toEqual([gameKey.toBase58()]);
  });

  it("serializes player and status events for the same game", async () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const ordered: string[] = [];

    const origAddPlayer = db.addPlayerToGame;
    db.addPlayerToGame = (game, player, index) => {
      ordered.push("player");
      return origAddPlayer(game, player, index);
    };

    const origMarkClosed = db.markGameClosed;
    db.markGameClosed = (game) => {
      ordered.push("closed");
      return origMarkClosed(game);
    };

    const origClearPlayers = db.clearStalePlayersForGame;
    db.clearStalePlayersForGame = (game) => {
      ordered.push("cleared");
      return origClearPlayers(game);
    };

    // Slow down auto-complete so the status event queues behind an in-flight player handler.
    (service as any).tryAutoComplete = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    const gameKey = Keypair.generate().publicKey;
    seedSecretForGame(db, gameKey.toBase58());
    const playerKey = Keypair.generate().publicKey;

    const playerPromise = service.events.handlePlayerEvent("joined", {
      gameKey,
      player: playerKey,
      ticketIndex: 1,
    });

    service.events.handleGameStatusChange("closed", { gameKey });

    await playerPromise;
    const queues: Map<string, Promise<void>> = (service.events as any).processingQueues;
    await Promise.all(Array.from(queues.values()));

    expect(callLog.addPlayer).toHaveLength(1);
    expect(callLog.markClosed).toEqual([gameKey.toBase58()]);
    expect(callLog.clearPlayers).toEqual([gameKey.toBase58()]);
    expect(ordered).toEqual(["player", "closed", "cleared"]);
  });

  it("tracks game initialization with derived type", () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const gameKey = Keypair.generate().publicKey;
    seedSecretForGame(db, gameKey.toBase58());

    service.events.handleGameInitialized({
      gameKey,
      gameType: { Coinflip: {} },
    });

    service.events.handleGameInitialized({ gameKey });

    expect(callLog.track).toEqual([
      { game: gameKey.toBase58(), type: "coinflip" },
      { game: gameKey.toBase58(), type: undefined },
    ]);
  });

  it("truncates oversized derived game types", () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const gameKey = Keypair.generate().publicKey;
    seedSecretForGame(db, gameKey.toBase58());
    const longKey = "A".repeat(512);

    service.events.handleGameInitialized({
      gameKey,
      gameType: { [longKey]: {} },
    });

    const tracked = callLog.track[0];
    expect(tracked?.game).toBe(gameKey.toBase58());
    expect(tracked?.type).toBe("a".repeat(128));
  });

  it("extracts event data from various representations", () => {
    const { db } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const gameKey = Keypair.generate().publicKey.toBase58();
    const event = {
      gameKey,
      player: { toString: () => "player-as-string" },
      ticket_index: { toNumber: () => 5 },
    };

    const data = service.events.extractEventData(event);

    expect(data.gameAddress).toBe(gameKey);
    expect(data.playerAddress).toBe("player-as-string");
    expect(data.ticketIndex).toBe(5);
  });

  it("extracts event data from wrapped public key helpers", () => {
    const { db } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const wrappedGameKey = Keypair.generate().publicKey;
    const wrappedPlayerKey = Keypair.generate().publicKey;

    const event = {
      gameKey: { some: wrappedGameKey },
      player: { value: wrappedPlayerKey },
      ticketIndex: { toNumber: () => 11 },
    };

    const data = service.events.extractEventData(event);

    expect(data.gameAddress).toBe(wrappedGameKey.toBase58());
    expect(data.playerAddress).toBe(wrappedPlayerKey.toBase58());
    expect(data.ticketIndex).toBe(11);
  });

  it("coercePublicKey unwraps option-like containers", () => {
    const key = Keypair.generate().publicKey;

    const viaSome = coercePublicKey({ some: key });
    const viaValue = coercePublicKey({ value: key });
    const viaMethod = coercePublicKey({ toBase58: () => key.toBase58() });

    expect(viaSome?.toBase58()).toBe(key.toBase58());
    expect(viaValue?.toBase58()).toBe(key.toBase58());
    expect(viaMethod?.toBase58()).toBe(key.toBase58());
  });

  it("evaluates on-chain presence of games", async () => {
    const { db } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const missing = await service.completionManager.resolveContextAndReadiness(
      "no-secret",
      {
        requireOnChain: true,
      },
    );
    expect(missing.status).toBe("missing-context");
    expect(programStub.fetchCalls).toHaveLength(0);

    const activeGame = "active-game";
    db.saveSecretKey(activeGame, "aa".repeat(32), "bb".repeat(32));

    programStub.fetchImpl = async (pda: PublicKey) => {
      programStub.fetchCalls.push(pda);
      return {};
    };
    const exists = await service.completionManager.resolveContextAndReadiness(
      activeGame,
      {
        requireOnChain: true,
      },
    );
    if (exists.status === "missing-context") {
      throw new Error("expected context for active game");
    }
    expect(exists.context.gamePda).toBeInstanceOf(PublicKey);
    expect(exists.readiness.gameAccount).toBeDefined();
    expect(programStub.fetchCalls).toHaveLength(1);

    const goneGame = "gone-game";
    db.saveSecretKey(goneGame, "cc".repeat(32), "dd".repeat(32));

    programStub.fetchImpl = async (pda: PublicKey) => {
      programStub.fetchCalls.push(pda);
      throw new Error("Account does not exist");
    };

    const gone = await service.completionManager.resolveContextAndReadiness(goneGame, {
      requireOnChain: true,
    });
    expect(gone.status).toBe("missing-context");
    expect(programStub.fetchCalls).toHaveLength(2);
  });

  it("preserves finalized games when initialization events replay", async () => {
    // Let's refactor it to use setupOracleServiceEnv but with proper isolation.
    const env = await setupOracleServiceEnv("oracle-service-events-finalized");
    try {
      const db = env.OracleDatabase.getInstance();
      const service = env.OracleService.createWith(db);

      const gameKey = Keypair.generate().publicKey;
      const gameAddress = gameKey.toBase58();

      db.saveSecretKey(gameAddress, "00".repeat(32), "11".repeat(32));
      db.trackGame(gameAddress);
      db.markGameCompleted(gameAddress);

      await service.events.handleGameInitialized({ gameKey });

      const pending = db.getPendingGames().map((entry) => entry.game_address);
      expect(pending).not.toContain(gameAddress);

      const status = db.getGameStatus(gameAddress);
      expect(status).toBe("completed");
    } finally {
      env.cleanup();
    }
  });

  // B-003: handlePlayerEvent processes out-of-order join/unjoin
  it("handles race conditions between joined and unjoined events", async () => {
    const { db } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub, {
      tryAutoComplete: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });

    const gameKey = Keypair.generate().publicKey;
    seedSecretForGame(db, gameKey.toBase58());
    const playerKey = Keypair.generate().publicKey;
    const ticketIndex = 10;

    // Mock db.addPlayerToGame to be slow
    const originalAdd = db.addPlayerToGame;
    let releaseAdd: ((value?: unknown) => void) | undefined;

    db.addPlayerToGame = (game, player, index) => {
      if (game === gameKey.toBase58() && index === ticketIndex) {
        // Delay the actual write
        setTimeout(() => {
           originalAdd.call(db, game, player, index);
           releaseAdd?.();
        }, 50);
      } else {
        originalAdd.call(db, game, player, index);
      }
    };

    // 1. Start 'joined' (will be slow)
    const joinPromise = service.events.handlePlayerEvent("joined", {
      gameKey,
      player: playerKey,
      ticketIndex,
    });

    // 2. Start 'unjoined' (fast, should happen "after" in theory, or we want to test if it overwrites)
    // If we assume unjoin happened later on chain, we want the final state to be unjoined.
    // If 'joined' is slow, 'unjoined' might finish first (removing nothing or removing if it was there),
    // then 'joined' finishes and adds the player.
    // Result: Player is present (WRONG).

    await new Promise((resolve) => setTimeout(resolve, 10)); // Give join a chance to start but hang

    const unjoinPromise = service.events.handlePlayerEvent("unjoined", {
      gameKey,
      player: playerKey,
      ticketIndex,
    });

    await new Promise((resolve) => { releaseAdd = resolve; }); // Wait for join to proceed
    await Promise.all([joinPromise, unjoinPromise]);

    // Wait a bit for any trailing asyncs
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Check final state in DB
    // We expect the player to be REMOVED (not in registry) because unjoin came last.
    // But due to the race, join wrote last.

    // Note: createDbStub uses an in-memory map.
    const registry = (db as any).getPlayerTicketStats(gameKey.toBase58());

    // This assertion expects the bug to be present (or fixed if we were fixing it).
    // The user asked to "propose targeted test improvements" (i.e. reproduce bugs).
    // So we expect this to FAIL if the code is buggy, or we assert the *correct* behavior and watch it fail.
    // I will assert the CORRECT behavior (registry count should be 0).
    expect(registry.count).toBe(0);
  });

  // B-006: RegistrySyncScheduler handles hanging syncFn
  it("recovers from hanging registry sync operations", async () => {
    const { db } = createDbStub();
    const programStub = createProgramStub();
    // Mock syncPlayerRegistry to hang on the first call
    let callCount = 0;

    const syncFn = async (_options: any) => {
      callCount++;
      if (callCount === 1) {
        // Exceed the scheduler timeout once, but eventually resolve so we don't
        // leak a never-ending promise into the test runner.
        await new Promise((resolve) => setTimeout(resolve, 250));
        return false;
      }
      return true;
    };

    const service = createService(db, programStub, { syncPlayerRegistry: syncFn });

    const gameKey = Keypair.generate().publicKey;
    seedSecretForGame(db, gameKey.toBase58());
    const playerKey = Keypair.generate().publicKey;

    // Pre-populate DB with ticket 0 to create a gap when ticket 2 arrives
    db.addPlayerToGame(gameKey.toBase58(), playerKey.toBase58(), 0);

    // 1. Trigger first sync (will hang)
    service.events.handlePlayerEvent("joined", {
      gameKey,
      player: playerKey,
      ticketIndex: 2, // Force gap to trigger sync
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // 2. Trigger second sync
    service.events.handlePlayerEvent("joined", {
      gameKey,
      player: playerKey,
      ticketIndex: 2,
    });

    // If the scheduler doesn't timeout the hanging task, the second task will never run.
    // We wait a bit (simulating the timeout period we EXPECT to exist, e.g. 100ms for test)
    // But the current code has NO timeout.

    // To make this test fail fast instead of timing out the whole suite, we can race against a timeout.
    // But we want to assert that it DOES recover.

    // We'll wait for a short duration. If callCount is still 1, it failed to recover.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Expect callCount to be 2 (implying the first one was aborted/timed out and second one ran)
    expect(callCount).toBeGreaterThanOrEqual(2);
    service.events.clearRegistrySyncs();
  });
});

import { GameCompletionManager } from "../oracle-completion-manager.ts";

function createService(
  db: OracleDatabaseStub,
  programStub: ProgramStub,
  optionsOverride: Partial<OracleEventProcessorOptions> = {},
): OracleServiceType {
  const options: OracleEventProcessorOptions = {
    getProgram: () => programStub as any,
    db: db as any,
    tryAutoComplete: async () => {},
    config: EVENT_HANDLER_CONFIG,
    clearTokenProgramCache: () => {},
    syncPlayerRegistry: async () => true,
    playerEventFlushDebounceMs: 0,
    autoCompleteDebounceMs: 0,
    registrySyncTimeoutMs: 100, // Short timeout for testing
    registrySyncRetryDelayMs: 50, // Short retry delay for testing
    ...optionsOverride,
  };

  const processor = new OracleEventProcessor(options);

  const connectionStub = {
    getSlot: async () => 0,
    getBlockTime: async () => Math.floor(Date.now() / 1000),
    getLatestBlockhash: async () => ({ blockhash: "", lastValidBlockHeight: 0 }),
    confirmTransaction: async (_sig?: string, _latest?: any) => {},
    getAccountInfo: async () => null,
  };

  const completionManager = new GameCompletionManager({
    db: db as any,
    getProgram: () => programStub as any,
    getConnection: () => connectionStub as any,
    adminKeypair: Keypair.generate() as any,
    metrics: {
      recordCompletion: () => {},
      recordScanCycle: () => {},
      recordCleanupSweep: () => {},
    },
    readinessCache: new Map(),
    tokenProgramCache: new Map(),
    secretKeyLength: 32,
    noSecretKeyMessage: "No secret key found",
    confirmTransaction: connectionStub.confirmTransaction,
  });

  const service = {
    events: processor,
    completionManager,
    program: programStub,
    connection: connectionStub,
    startEventListening: async () => processor.startListening(),
    stopEventListening: async () => processor.stopListening(),
    getStats: () => ({ eventListening: processor.isListening() }),
  };
  return service as any;
}

type CallLog = {
  addPlayer: Array<{ game: string; player: string; index: number }>;
  removePlayer: Array<{ game: string; index: number }>;
  clearPlayers: string[];
  track: Array<{ game: string; type: string | undefined }>;
  markCompleted: string[];
  markClosed: string[];
  markDesynced: string[];
  replacePlayers: Array<{ game: string; players: string[] }>;
};

function createDbStub(): { db: OracleDatabaseStub; callLog: CallLog } {
  const callLog: CallLog = {
    addPlayer: [],
    removePlayer: [],
    clearPlayers: [],
    track: [],
    markCompleted: [],
    markClosed: [],
    markDesynced: [],
    replacePlayers: [],
  };

  const secretKeys = new Map<string, { secretKey: string; randomHash: string }>();
  const playerRegistry = new Map<string, Map<number, string>>();

  const ensureRegistry = (game: string) => {
    let registry = playerRegistry.get(game);
    if (!registry) {
      registry = new Map();
      playerRegistry.set(game, registry);
    }
    return registry;
  };

  const db: OracleDatabaseStub = {
    addPlayerToGame(game, player, index) {
      callLog.addPlayer.push({ game, player, index });
      ensureRegistry(game).set(index, player);
    },
    deleteSecretKey(game) {
      secretKeys.delete(game);
    },
    removePlayerFromGame(game, index) {
      callLog.removePlayer.push({ game, index });
      ensureRegistry(game).delete(index);
    },
    clearStalePlayersForGame(game) {
      callLog.clearPlayers.push(game);
      playerRegistry.delete(game);
    },
    trackGame(game, type, _options) {
      callLog.track.push({ game, type: type ?? undefined });
    },
    markGameCompleted(game) {
      callLog.markCompleted.push(game);
    },
    markGameDesynced(game) {
      callLog.markDesynced.push(game);
    },
    finalizeCompletedGame(game) {
      callLog.markCompleted.push(game);
    },
    markGameClosed(game) {
      callLog.markClosed.push(game);
    },
    getSecretKey(game) {
      return secretKeys.get(game) ?? null;
    },
    saveSecretKey(game, secretKey, randomHash) {
      secretKeys.set(game, { secretKey, randomHash });
    },
    getPendingGames(_maxAttempts?: number) {
      return [];
    },
    cleanupOldRecords() {
      return { deletedSecrets: 0, deletedGames: 0, deletedPlayers: 0 };
    },
    getStats() {
      return {
        totalSecrets: 0,
        usedSecrets: 0,
        pendingGames: 0,
        completedGames: 0,
        cancelledGames: 0,
      };
    },
    markSecretKeyUsed() {},
    incrementCompletionAttempts() {},
    getPlayerTicketStats(game) {
      const registry = playerRegistry.get(game);
      if (!registry || registry.size === 0) {
        return { count: 0, maxIndex: null, minIndex: null };
      }
      const indexes = [...registry.keys()];
      const maxIndex = Math.max(...indexes);
      const minIndex = Math.min(...indexes);
      return { count: registry.size, maxIndex, minIndex };
    },
    replaceGamePlayers(game, players) {
      callLog.replacePlayers.push({ game, players: [...players] });
      const registry = ensureRegistry(game);
      registry.clear();
      players.forEach((player, index) => {
        registry.set(index, player);
      });
    },
  };

  return { db, callLog };
}

type OracleDatabaseStub = Partial<OracleDatabase> & {
  addPlayerToGame(game: string, player: string, index: number): void;
  removePlayerFromGame(game: string, index: number): void;
  clearStalePlayersForGame(game: string): void;
  trackGame(game: string, type?: string | null, options?: { preserveFinalized?: boolean }): void;
  markGameCompleted(game: string): void;
  markGameDesynced(game: string): void;
  finalizeCompletedGame(game: string): void;
  markGameClosed(game: string): void;
  getSecretKey(game: string): { secretKey: string; randomHash: string } | null;
  saveSecretKey(game: string, secretKey: string, randomHash: string): void;
  deleteSecretKey(game: string): void;
  getPendingGames(maxAttempts?: number): Array<{
    game_address: string;
    completion_attempts: number;
  }>;
  cleanupOldRecords(): {
    deletedSecrets: number;
    deletedGames: number;
    deletedPlayers: number;
  };
  getStats(): {
    totalSecrets: number;
    usedSecrets: number;
    pendingGames: number;
    completedGames: number;
    cancelledGames: number;
  };
  markSecretKeyUsed(game: string): void;
  incrementCompletionAttempts(game: string): void;
  getPlayerTicketStats(game: string): { count: number; maxIndex: number | null; minIndex: number | null };
  replaceGamePlayers(game: string, players: string[]): void;
};
