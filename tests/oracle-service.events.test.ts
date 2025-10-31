import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { coercePublicKey } from "../solana-utils.ts";
import type { OracleDatabase } from "../database.ts";
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
    expect(statsWhileListening.activeListeners).toBe(5);

    await service.startEventListening();
    expect(programStub.addCalls.length).toBe(5);

    await service.stopEventListening();
    expect(programStub.removeCalls).toEqual([1, 2, 3, 4, 5]);

    const statsAfterStop = service.getStats();
    expect(statsAfterStop.eventListening).toBe(false);
    expect(statsAfterStop.activeListeners).toBe(0);
  });

  it("awaits asynchronous event listener registration", async () => {
    const { db } = createDbStub();
    const programStub = createProgramStub({ asyncRegistration: true });
    const service = createService(db, programStub);

    await service.startEventListening();

    const listeners = (service as any).eventListeners as Array<number>;
    expect(listeners.every((id) => typeof id === "number")).toBe(true);

    await service.stopEventListening();
    expect(programStub.removeCalls).toEqual([1, 2, 3, 4, 5]);
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

    await (service as any).handlePlayerEvent("joined", {
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

    await (service as any).handlePlayerEvent("unjoined", {
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

  it("ignores player events with missing data", async () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    (service as any).tryAutoComplete = async () => {
      throw new Error("should not be called");
    };

    const gameKey = Keypair.generate().publicKey;

    await (service as any).handlePlayerEvent("joined", {
      gameKey,
      ticketIndex: 3,
    });

    await (service as any).handlePlayerEvent("joined", {
      gameKey,
      player: Keypair.generate().publicKey,
    });

    await (service as any).handlePlayerEvent("unjoined", {
      gameKey,
      player: Keypair.generate().publicKey,
    });

    expect(callLog.addPlayer).toEqual([]);
    expect(callLog.removePlayer).toEqual([]);
  });

  it("updates game status in response to events", async () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const gameKey = Keypair.generate().publicKey;

    (service as any).handleGameStatusChange("completed", { gameKey });
    (service as any).handleGameStatusChange("closed", { gameKey });

    expect(callLog.markCompleted).toEqual([gameKey.toBase58()]);
    expect(callLog.markClosed).toEqual([gameKey.toBase58()]);
    expect(callLog.clearPlayers).toEqual([gameKey.toBase58()]);
  });

  it("tracks game initialization with derived type", () => {
    const { db, callLog } = createDbStub();
    const programStub = createProgramStub();
    const service = createService(db, programStub);

    const gameKey = Keypair.generate().publicKey;

    (service as any).handleGameInitialized({
      gameKey,
      gameType: { Coinflip: {} },
    });

    (service as any).handleGameInitialized({ gameKey });

    expect(callLog.track).toEqual([
      { game: gameKey.toBase58(), type: "coinflip" },
      { game: gameKey.toBase58(), type: undefined },
    ]);
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

    const data = (service as any).extractEventData(event);

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

    const data = (service as any).extractEventData(event);

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

    const missing = await (service as any).resolveContextAndReadiness(
      "no-secret",
      {
        requireOnChain: true,
      },
    );
    expect(missing.context).toBeNull();
    expect(programStub.fetchCalls).toHaveLength(0);

    const activeGame = "active-game";
    db.saveSecretKey(activeGame, "aa".repeat(32), "bb".repeat(32));

    programStub.fetchImpl = async (pda: PublicKey) => {
      programStub.fetchCalls.push(pda);
      return {};
    };
    const exists = await (service as any).resolveContextAndReadiness(
      activeGame,
      {
        requireOnChain: true,
      },
    );
    expect(exists.context?.gamePda).toBeInstanceOf(PublicKey);
    expect(exists.readiness?.gameAccount).toBeDefined();
    expect(programStub.fetchCalls).toHaveLength(1);

    const goneGame = "gone-game";
    db.saveSecretKey(goneGame, "cc".repeat(32), "dd".repeat(32));

    programStub.fetchImpl = async (pda: PublicKey) => {
      programStub.fetchCalls.push(pda);
      throw new Error("Account does not exist");
    };

    const gone = await (service as any).resolveContextAndReadiness(goneGame, {
      requireOnChain: true,
    });
    expect(gone.context).toBeNull();
    expect(programStub.fetchCalls).toHaveLength(2);
  });
});

function createService(db: OracleDatabaseStub, programStub: ProgramStub): OracleServiceType {
  const service = Object.create(OracleServiceClass.prototype) as OracleServiceType;
  (service as any).db = db;
  (service as any).program = programStub;
  (service as any).eventListeners = [];
  (service as any).isListening = false;
  (service as any).connection = null;
  (service as any).adminKeypair = Keypair.generate();
  (service as any).getBlockchainTime = async () => Math.floor(Date.now() / 1000);
  (service as any).readinessCache = new Map();
  return service;
}

type CallLog = {
  addPlayer: Array<{ game: string; player: string; index: number }>;
  removePlayer: Array<{ game: string; index: number }>;
  clearPlayers: string[];
  track: Array<{ game: string; type: string | undefined }>;
  markCompleted: string[];
  markClosed: string[];
};

function createDbStub(): { db: OracleDatabaseStub; callLog: CallLog } {
  const callLog: CallLog = {
    addPlayer: [],
    removePlayer: [],
    clearPlayers: [],
    track: [],
    markCompleted: [],
    markClosed: [],
  };

  const secretKeys = new Map<string, { secretKey: string; randomHash: string }>();

  const db: OracleDatabaseStub = {
    addPlayerToGame(game, player, index) {
      callLog.addPlayer.push({ game, player, index });
    },
    removePlayerFromGame(game, index) {
      callLog.removePlayer.push({ game, index });
    },
    clearStalePlayersForGame(game) {
      callLog.clearPlayers.push(game);
    },
    trackGame(game, type) {
      callLog.track.push({ game, type: type ?? undefined });
    },
    markGameCompleted(game) {
      callLog.markCompleted.push(game);
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
  };

  return { db, callLog };
}

type OracleDatabaseStub = Partial<OracleDatabase> & {
  addPlayerToGame(game: string, player: string, index: number): void;
  removePlayerFromGame(game: string, index: number): void;
  clearStalePlayersForGame(game: string): void;
  trackGame(game: string, type?: string | null): void;
  markGameCompleted(game: string): void;
  finalizeCompletedGame(game: string): void;
  markGameClosed(game: string): void;
  getSecretKey(game: string): { secretKey: string; randomHash: string } | null;
  saveSecretKey(game: string, secretKey: string, randomHash: string): void;
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
};

