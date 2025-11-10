import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { coercePublicKey } from "../solana-utils.ts";
import { OracleEventProcessor } from "../oracle-event-processor.ts";
import type { OracleDatabase } from "../database.ts";
import type { OracleMetrics } from "../metrics.ts";
import { setupOracleServiceEnv } from "./helpers/setup-oracle-service-env.ts";
import {
  createProgramStub,
  type ProgramStub,
} from "./helpers/program-stub.ts";

type OracleServiceType = import("../oracle-service.ts").OracleService;

let OracleServiceClass: typeof import("../oracle-service.ts").OracleService;
let cleanup: () => void;

beforeAll(async () => {
  const env = await setupOracleServiceEnv("oracle-service-events-test");
  OracleServiceClass = env.OracleService;
  cleanup = env.cleanup;
});

afterAll(() => {
  cleanup?.();
});

describe("OracleService event handling", () => {
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
      OracleServiceClass.EVENT_HANDLER_CONFIG.length
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
      OracleServiceClass.EVENT_HANDLER_CONFIG.length
    );
    expect(service.events.getActiveListenerCount()).toBe(
      OracleServiceClass.EVENT_HANDLER_CONFIG.length
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
      OracleServiceClass.EVENT_HANDLER_CONFIG.length,
    );
    expect(processor.getActiveListenerCount()).toBe(
      OracleServiceClass.EVENT_HANDLER_CONFIG.length,
    );

    await processor.stopListening();
  });

  it("processes player join and unjoin events", async () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const autoCompleteCalls: Array<[PublicKey, string, string]> = [];
    (service as any).tryAutoComplete = async (
      ...args: [PublicKey, string, string]
    ): Promise<void> => {
      autoCompleteCalls.push(args);
    };

    const gameKey = Keypair.generate().publicKey;
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

  it("requests registry reconciliation when ticket indexes skip", async () => {
    const { db } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const syncCalls: Array<{ gameAddress: string; expectedTickets?: number; trigger: string }> = [];
    (service as any).syncPlayerRegistry = async (options: any) => {
      syncCalls.push({
        gameAddress: options.gameAddress,
        expectedTickets: options.expectedTickets,
        trigger: options.trigger,
      });
      return true;
    };

    const gameKey = Keypair.generate().publicKey;
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
    const service = createService(db, programStub);

    const syncCalls: Array<{ gameAddress: string; expectedTickets?: number; trigger: string }> = [];
    const deferred = createDeferred<boolean>();

    (service as any).syncPlayerRegistry = async (options: any) => {
      syncCalls.push(options);
      return deferred.promise;
    };

    const gameKey = Keypair.generate().publicKey;
    const playerKey = Keypair.generate().publicKey;

    const first = service.events.handlePlayerEvent("joined", {
      gameKey,
      player: playerKey,
      ticketIndex: 2,
      ticketsCount: 3,
    });

    const second = service.events.handlePlayerEvent("joined", {
      gameKey,
      player: playerKey,
      ticketIndex: 2,
      ticketsCount: 3,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(syncCalls).toHaveLength(1);

    deferred.resolve(true);
    await Promise.all([first, second]);

    expect(syncCalls).toHaveLength(1);
  });

  it("retries player registry sync when a pending request arrives during a failed attempt", async () => {
    const { db } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const processor = service.events as any;
    processor.registrySyncRetryDelayMs = 0;
    processor.scheduleRetryTimeout = (callback: () => void) => {
      callback();
      return 0;
    };
    processor.clearRetryTimeout = () => {};

    const firstAttempt = createDeferred<boolean>();
    const syncCalls: Array<{ gameAddress: string; trigger: string }> = [];

    (service as any).syncPlayerRegistry = async (options: any) => {
      syncCalls.push({ gameAddress: options.gameAddress, trigger: options.trigger });
      if (syncCalls.length === 1) {
        return firstAttempt.promise;
      }
      return true;
    };

    const gameKey = Keypair.generate().publicKey;
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
    expect(syncCalls).toHaveLength(1);

    firstAttempt.resolve(false);

    await Promise.all([first, second]);

    expect(syncCalls).toHaveLength(2);
    expect(syncCalls[0]?.gameAddress).toBe(gameKey.toBase58());
    expect(syncCalls[1]?.gameAddress).toBe(gameKey.toBase58());
  });

  it("throttles player registry sync retries after repeated failures", async () => {
    const { db } = createDbStub();
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
      getProgram: () =>
        ({
          addEventListener: async () => 0,
          removeEventListener: async () => {},
        }) as any,
      db: db as unknown as OracleDatabase,
      tryAutoComplete: async () => {},
      config: [],
      clearTokenProgramCache: () => {},
      syncPlayerRegistry: async (options) => {
        const attempt = syncCalls.length + 1;
        syncCalls.push({ attempt, trigger: options.trigger });
        return outcomes[attempt - 1] ?? true;
      },
      setTimeoutFn: setTimeoutStub,
      clearTimeoutFn: clearTimeoutStub,
      registrySyncRetryDelayMs: retryDelayMs,
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

    service.events.handleGameStatusChange("completed", { gameKey });
    service.events.handleGameStatusChange("closed", { gameKey });

    expect(callLog.markCompleted).toEqual([gameKey.toBase58()]);
    expect(callLog.markClosed).toEqual([gameKey.toBase58()]);
    expect(callLog.clearPlayers).toEqual([gameKey.toBase58()]);
  });

  it("tracks game initialization with derived type", () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const gameKey = Keypair.generate().publicKey;

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
    const env = await setupOracleServiceEnv("oracle-service-events-finalized");
    const { OracleService, OracleDatabase, cleanup: envCleanup } = env;

    try {
      const db = OracleDatabase.getInstance();
      const service = OracleService.createWith(db);

      const gameKey = Keypair.generate().publicKey;
      const gameAddress = gameKey.toBase58();

      db.trackGame(gameAddress);
      db.markGameCompleted(gameAddress);

      await service.events.handleGameInitialized({ gameKey });

      const pending = db.getPendingGames().map((entry) => entry.game_address);
      expect(pending).not.toContain(gameAddress);

      const sqlite = (db as any).db as {
        prepare: (
          sql: string,
        ) => { get: (...args: unknown[]) => { status?: string } | undefined };
      };

      const statusRow = sqlite
        .prepare("SELECT status FROM game_tracking WHERE game_address = ?")
        .get(gameAddress) as { status?: string } | undefined;

      expect(statusRow?.status).toBe("completed");
    } finally {
      envCleanup();
    }
  });
});

function createService(db: OracleDatabaseStub, programStub: ProgramStub): OracleServiceType {
  const metricsStub: OracleMetrics = {
    recordCompletion() {},
    recordScanCycle() {},
    recordCleanupSweep() {},
  };

  const service = OracleServiceClass.createWith(db as unknown as OracleDatabase, {
    metrics: metricsStub,
  });

  (service as any).program = programStub;
  (service as any).connection = {
    getSlot: async () => 0,
    getBlockTime: async () => Math.floor(Date.now() / 1000),
    getLatestBlockhash: async () => ({ blockhash: "", lastValidBlockHeight: 0 }),
    confirmTransaction: async () => {},
    getAccountInfo: async () => null,
  };

  return service;
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
