import { beforeAll, afterAll, describe, it, expect } from "bun:test";
import { unlinkSync } from "fs";
import { Keypair, PublicKey } from "@solana/web3.js";

let OracleService: typeof import("../oracle-service.ts").OracleService;
let OracleDatabase: typeof import("../database.ts").OracleDatabase;

beforeAll(async () => {
  process.env["NODE_ENV"] = "test";
  process.env["SOLANA_NETWORK"] = "http://localhost";
  process.env["DATABASE_FILE"] = "oracle-service-extra-test.sqlite";

  ({ OracleService } = await import("../oracle-service.ts"));
  ({ OracleDatabase } = await import("../database.ts"));
  (OracleService as any).instance = undefined;
  (OracleDatabase as any).instance = undefined;
});

afterAll(() => {
  const db = OracleDatabase.getInstance();
  db.close();
  try {
    unlinkSync(process.env["DATABASE_FILE"]!);
  } catch {}
  (OracleService as any).instance = undefined;
  (OracleDatabase as any).instance = undefined;
});

describe("OracleService internals", () => {
  it("start/stop event listening manages listener ids", async () => {
    const service = OracleService.getInstance();
    // stub program with minimal event API
    const fakeProgramId = Keypair.generate().publicKey;
    const added: number[] = [];
    (service as any).program = {
      programId: fakeProgramId,
      addEventListener: (_name: string, _h: any) => {
        const id = Math.floor(Math.random() * 10000);
        added.push(id);
        return id;
      },
      removeEventListener: async (_id: number) => {
        // remove OK
        return Promise.resolve();
      },
      account: { game: { fetch: async () => ({}) } },
    };

    await service.startEventListening();
    const stats1 = service.getStats();
    expect(stats1.eventListening).toBe(true);
    expect(stats1.activeListeners).toBeGreaterThan(0);

    await service.stopEventListening();
    const stats2 = service.getStats();
    expect(stats2.eventListening).toBe(false);
    expect(stats2.activeListeners).toBe(0);
  });

  it("handles player join/unjoin events and tries autocomplete", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    (service as any).tryAutoComplete = async () => {};

    const gameAddr = "game-evt";
    const player1 = Keypair.generate().publicKey.toBase58();
    const event = {
      gameKey: new PublicKey(Keypair.generate().publicKey.toBytes()),
      player: new PublicKey(Keypair.generate().publicKey.toBytes()),
    };
    // override extractor to force deterministic addresses
    (service as any).extractEventData = () => ({ gameAddress: gameAddr, playerAddress: player1 });

    await (service as any).handlePlayerEvent("joined", event);
    expect(db.getGamePlayers(gameAddr)).toEqual([player1]);

    await (service as any).handlePlayerEvent("unjoined", event);
    expect(db.getGamePlayers(gameAddr)).toEqual([]);
  });

  it("handles game status changes and initialization", () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    const gameAddr = "game-status";
    (service as any).extractEventData = () => ({ gameAddress: gameAddr, playerAddress: "" });

    (service as any).handleGameStatusChange("completed", { gameKey: Keypair.generate().publicKey });
    (service as any).handleGameStatusChange("closed", { gameKey: Keypair.generate().publicKey });
    // Not asserting DB state here beyond no-throw; mark closed clears players
    db.addPlayerToGame(gameAddr, "p1");
    (service as any).handleGameStatusChange("closed", { gameKey: Keypair.generate().publicKey });
    expect(db.getGamePlayers(gameAddr)).toEqual([]);

    (service as any).handleGameInitialized({
      gameKey: Keypair.generate().publicKey,
      gameType: { Coinflip: {} },
    });
  });

  it("isGameReadyForCompletion returns false and marks completed if account missing", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    const addr = Keypair.generate().publicKey.toBase58();
    db.trackGame(addr);
    (service as any).program = {
      account: {
        game: {
          fetch: async () => {
            const e: any = new Error("Account does not exist");
            e.message = "Account does not exist";
            throw e;
          },
        },
      },
    };
    const res = await service.isGameReadyForCompletion(new PublicKey(addr));
    expect(res).toBe(false);
    // now pending list should not contain addr since marked completed
    const pending = db.getPendingGames().map((g) => g.game_address);
    expect(pending.includes(addr)).toBe(false);
  });

  it("completeGame error cases: missing secret, not ready, no players", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    service.cleanupOldRecords(-1);

    // missing secret
    let res = await service.completeGame("no-secret");
    expect(res.success).toBe(false);

    // not ready
    db.saveSecretKey("not-ready", "deadbeef", "bead");
    // ensure programId exists for PDA derivation inside completeGame
    (service as any).program = {
      programId: Keypair.generate().publicKey,
      account: { game: { fetch: async () => ({ ticketsCount: 1, maxTickets: 10, minTickets: 1, lastSlot: 1 }) } },
    };
    (service as any).isGameReadyForCompletion = async () => false;
    res = await service.completeGame("not-ready");
    expect(res.notReady).toBe(true);

    // no players
    db.saveSecretKey("no-players", "deadbeef", "bead");
    (service as any).isGameReadyForCompletion = async () => true;
    // stub fetch to provide meta for winner calc
    (service as any).program = {
      programId: Keypair.generate().publicKey,
      account: { game: { fetch: async () => ({ ticketsCount: 1, maxTickets: 10, minTickets: 1, lastSlot: 1 }) } },
    };
    res = await service.completeGame("no-players");
    expect(res.success).toBe(false);
    expect(String(res.error || "")).toContain("No players");
  });

  it("completeGame success path marks DB and returns tx hash", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    service.cleanupOldRecords(-1);
    const gameAddr = "ok-game";
    db.saveSecretKey(gameAddr, "a".repeat(64), "b".repeat(64));
    db.trackGame(gameAddr);
    db.addPlayerToGame(gameAddr, Keypair.generate().publicKey.toBase58());
    db.addPlayerToGame(gameAddr, Keypair.generate().publicKey.toBase58());
    (service as any).isGameReadyForCompletion = async () => true;
    (service as any).program = {
      programId: Keypair.generate().publicKey,
      account: { game: { fetch: async () => ({ ticketsCount: 2, maxTickets: 2, minTickets: 1, lastSlot: 123 }) } },
    };
    (service as any).executeGameCompletion = async () => "tx123";

    const res = await service.completeGame(gameAddr);
    expect(res.success).toBe(true);
    expect(res.txHash).toBe("tx123");
    // secret should be marked used
    expect(db.getSecretKey(gameAddr)).toBeNull();
  });

  it("gameExistsOnChain reflects DB and chain state", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    service.cleanupOldRecords(-1);

    // without secret
    expect(await (service as any).gameExistsOnChain("no-secret-yet")).toBe(false);

    // with secret but missing account
    db.saveSecretKey("missing", "aa", "bb");
    (service as any).program = {
      programId: Keypair.generate().publicKey,
      account: {
        game: {
          fetch: async () => {
            const e: any = new Error("Account does not exist");
            e.message = "Account does not exist";
            throw e;
          },
        },
      },
    };
    expect(await (service as any).gameExistsOnChain("missing")).toBe(false);

    // with secret and account exists
    (service as any).program = { programId: Keypair.generate().publicKey, account: { game: { fetch: async () => ({}) } } };
    expect(await (service as any).gameExistsOnChain("missing")).toBe(true);
  });

  it("getBlockchainTime uses network and falls back to wall clock", async () => {
    const service = OracleService.getInstance();
    // happy path
    (service as any).connection = {
      getSlot: async () => 1,
      getBlockTime: async (_slot: number) => 1000,
    };
    expect(await (service as any).getBlockchainTime()).toBe(1000);

    // error path -> fallback to Date.now
    (service as any).connection = {
      getSlot: async () => {
        throw new Error("boom");
      },
      getBlockTime: async () => null,
    };
    const approx = await (service as any).getBlockchainTime();
    expect(Math.abs(approx - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(1);
  });
});
