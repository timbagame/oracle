import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Keypair } from "./helpers/solana-fixtures.ts";
import { setupOracleServiceEnv } from "./helpers/setup-oracle-service-env.ts";
import { seedTrackedGame } from "./helpers/seed-tracked-game.ts";
import { logger } from "../logger.ts";
import type { OracleEventProcessorOptions } from "../oracle-event-processor.ts";
import type { GameOnChainContext } from "../oracle-service.types.ts";

type OracleServiceClass = typeof import("../oracle-service.ts").OracleService;
type OracleDatabaseClass = typeof import("../database.ts").OracleDatabase;
type OracleServiceInstance = import("../oracle-service.ts").OracleService;

let OracleService: OracleServiceClass;
let OracleDatabase: OracleDatabaseClass;
let cleanup: () => void;
const restores: Array<() => void> = [];

beforeAll(async () => {
  const env = await setupOracleServiceEnv("oracle-service-wakeups-test");
  ({ OracleService, OracleDatabase, cleanup } = env);
});

afterAll(() => {
  cleanup();
});

afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

async function createService(): Promise<OracleServiceInstance> {
  const service = await OracleService.createWith(OracleDatabase.getInstance());
  service.cleanupOldRecords(-1);
  return service;
}

function newAddress(): string {
  return Keypair.generate().publicKey.toBase58();
}

function seedGame(): string {
  const address = newAddress();
  seedTrackedGame(OracleDatabase.getInstance(), {
    address,
    secret: "c".repeat(64),
    randomHash: "d".repeat(64),
  });
  return address;
}

function eventOptions(service: OracleServiceInstance): OracleEventProcessorOptions {
  return (service.events as unknown as { options: OracleEventProcessorOptions }).options;
}

function captureTimers(): Array<() => void> {
  const callbacks: Array<() => void> = [];
  const timer = { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
  const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    callbacks.push(callback);
    return timer;
  }) as unknown as typeof setTimeout);
  const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  restores.push(
    () => setSpy.mockRestore(),
    () => clearSpy.mockRestore(),
  );
  return callbacks;
}

async function flush(times = 10): Promise<void> {
  for (let index = 0; index < times; index++) await Promise.resolve();
}

describe("OracleService.queueGameCompletion", () => {
  test("rejects a blank game address", async () => {
    const service = await createService();

    await expect(service.queueGameCompletion("   ")).resolves.toEqual({
      success: false,
      error: "gameAddress is required",
    });
  });

  test("returns immediately and runs the completion in the background", async () => {
    const service = await createService();
    const gameAddress = seedGame();
    let release!: () => void;
    const attempt = spyOn(service as any, "attemptGameCompletion").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ success: true, txHash: "sig" });
        }),
    );
    restores.push(() => attempt.mockRestore());

    await expect(service.queueGameCompletion(` ${gameAddress} `)).resolves.toBeNull();
    await flush();

    expect(attempt).toHaveBeenCalledTimes(1);
    const options = attempt.mock.calls[0]![0] as {
      gameAddress: string;
      successLog: () => string;
      failureLog: (address: string, error?: string) => string;
    };
    expect(options.gameAddress).toBe(gameAddress);
    expect(options.successLog()).toBe(`🎯 Completed game ${gameAddress} after bot wake-up`);
    expect(options.failureLog(gameAddress)).toBe(
      "❌ Bot-triggered completion failed: Unknown error",
    );
    expect(options.failureLog(gameAddress, "boom")).toBe(
      "❌ Bot-triggered completion failed: boom",
    );
    release();
    await flush();
  });

  test("logs a warning when the background wake-up rejects", async () => {
    const service = await createService();
    const gameAddress = newAddress();
    const failure = new Error("admission exploded");
    const start = spyOn(service as any, "startAutomaticCompletionAttempt").mockRejectedValue(
      failure,
    );
    const warning = spyOn(logger, "warning").mockImplementation(() => {});
    restores.push(
      () => start.mockRestore(),
      () => warning.mockRestore(),
    );

    await expect(service.queueGameCompletion(gameAddress)).resolves.toBeNull();
    await flush();

    expect(warning).toHaveBeenCalledWith(
      `Bot completion wake-up failed for ${gameAddress}:`,
      failure,
    );
  });
});

describe("OracleService.setAutoCompleteDisabled", () => {
  test("drops cached readiness when the flag changes", async () => {
    const service = await createService();
    const gameAddress = seedGame();
    service.readinessCache.set(gameAddress, { ready: true } as never);

    const result = service.setAutoCompleteDisabled(` ${gameAddress} `, true);

    expect(result).toMatchObject({ success: true, autoCompleteDisabled: true });
    expect(service.readinessCache.has(gameAddress)).toBe(false);
    expect(OracleDatabase.getInstance().getCompletionAttemptState(gameAddress)).toMatchObject({
      autoCompleteDisabled: true,
    });
  });

  test("keeps cached readiness when the game is unknown", async () => {
    const service = await createService();
    const gameAddress = newAddress();
    service.readinessCache.set(gameAddress, { ready: true } as never);

    expect(service.setAutoCompleteDisabled(gameAddress, true)).toMatchObject({ success: false });
    expect(service.readinessCache.has(gameAddress)).toBe(true);
  });
});

describe("OracleService player registry sync", () => {
  test("replaces stored players with the on-chain registry for a known game key", async () => {
    const service = await createService();
    const gameAddress = seedGame();
    const gameKey = Keypair.generate().publicKey;
    const players = [newAddress(), newAddress()];
    const fetchPlayers = spyOn(
      (service as any).registrySync,
      "fetchPlayersFromChain",
    ).mockResolvedValue(players);
    restores.push(() => fetchPlayers.mockRestore());

    const synced = await eventOptions(service).syncPlayerRegistry!({
      gameAddress,
      gameKey,
      expectedTickets: 2,
      trigger: "player joined",
    });

    expect(synced).toBe(true);
    expect(fetchPlayers).toHaveBeenCalledWith({
      gamePda: gameKey.toBase58(),
      expectedTickets: 2,
    });
    expect(OracleDatabase.getInstance().getGamePlayers(gameAddress)).toEqual(players);
  });

  test("resolves the game PDA from stored secrets when no key is given", async () => {
    const service = await createService();
    const gameAddress = seedGame();
    const gamePda = Keypair.generate().publicKey;
    const resolve = spyOn(service.completionManager, "resolveStoredGame").mockResolvedValue({
      gamePda,
    } as unknown as GameOnChainContext);
    const fetchPlayers = spyOn(
      (service as any).registrySync,
      "fetchPlayersFromChain",
    ).mockResolvedValue(null);
    restores.push(
      () => resolve.mockRestore(),
      () => fetchPlayers.mockRestore(),
    );

    const synced = await eventOptions(service).syncPlayerRegistry!({
      gameAddress,
      trigger: "scan",
    });

    expect(synced).toBe(false);
    expect(resolve).toHaveBeenCalledWith(gameAddress);
    expect(fetchPlayers).toHaveBeenCalledWith({
      gamePda: gamePda.toBase58(),
      expectedTickets: undefined,
    });
  });

  test("gives up when the game PDA cannot be resolved", async () => {
    const service = await createService();
    const gameAddress = newAddress();
    const resolve = spyOn(service.completionManager, "resolveStoredGame").mockResolvedValue(null);
    const fetchPlayers = spyOn((service as any).registrySync, "fetchPlayersFromChain");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    restores.push(
      () => resolve.mockRestore(),
      () => fetchPlayers.mockRestore(),
      () => warn.mockRestore(),
    );

    const synced = await eventOptions(service).syncPlayerRegistry!({
      gameAddress,
      trigger: "scan",
    });

    expect(synced).toBe(false);
    expect(fetchPlayers).not.toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      `Unable to reconcile players for ${gameAddress}`,
    );
  });

  test("reports a failed chain read without touching stored players", async () => {
    const service = await createService();
    const gameAddress = seedGame();
    const existingPlayer = newAddress();
    OracleDatabase.getInstance().addPlayerToGame(gameAddress, existingPlayer, 0);
    const fetchPlayers = spyOn(
      (service as any).registrySync,
      "fetchPlayersFromChain",
    ).mockRejectedValue("rpc down");
    const failure = spyOn(logger, "failure").mockImplementation(() => {});
    restores.push(
      () => fetchPlayers.mockRestore(),
      () => failure.mockRestore(),
    );

    const synced = await eventOptions(service).syncPlayerRegistry!({
      gameAddress,
      gameKey: Keypair.generate().publicKey,
      trigger: "scan",
    });

    expect(synced).toBe(false);
    expect(failure).toHaveBeenCalledWith(
      `Failed to synchronize players for ${gameAddress}: rpc down`,
    );
    expect(OracleDatabase.getInstance().getGamePlayers(gameAddress)).toEqual([existingPlayer]);
  });
});

describe("OracleService event wiring", () => {
  test("routes event auto-complete triggers into the completion machinery", async () => {
    const service = await createService();
    const gameAddress = seedGame();
    const attempt = spyOn(service as any, "attemptGameCompletion").mockResolvedValue({
      success: true,
    });
    restores.push(() => attempt.mockRestore());

    await eventOptions(service).tryAutoComplete(undefined, gameAddress, "player joined");

    expect(attempt).toHaveBeenCalledTimes(1);
    const options = attempt.mock.calls[0]![0] as { gameAddress: string; gameKey: unknown };
    expect(options.gameAddress).toBe(gameAddress);
    expect(String(options.gameKey)).toBe(gameAddress);
  });

  test("clears retries and prefetch schedules when a game is finalized", async () => {
    const service = await createService();
    const gameAddress = newAddress();
    const reset = spyOn(service.completionManager, "resetRegistryPrefetchSchedule");
    restores.push(() => reset.mockRestore());
    const retries = (service as any).completionRetries as Map<string, unknown>;
    retries.set(gameAddress, { phase: "active" });

    eventOptions(service).onGameFinalized!(gameAddress);

    expect(retries.has(gameAddress)).toBe(false);
    expect(reset).toHaveBeenCalledWith(gameAddress);
  });

  test("forwards program event observers to the event processor", async () => {
    const service = await createService();
    const observer = () => {};
    const unsubscribe = () => {};
    const add = spyOn(service.events, "addProgramEventObserver").mockReturnValue(unsubscribe);
    restores.push(() => add.mockRestore());

    expect(service.addProgramEventObserver(observer)).toBe(unsubscribe);
    expect(add).toHaveBeenCalledWith(observer);
  });

  test("exposes the active RPC connection", async () => {
    const service = await createService();

    expect(service.getConnection()).toBe((service as any).connection);
  });

  test("rethrows and logs listener start failures", async () => {
    const service = await createService();
    const error = new Error("subscribe failed");
    const start = spyOn(service.events, "startListening").mockRejectedValue(error);
    const failure = spyOn(logger, "failure").mockImplementation(() => {});
    restores.push(
      () => start.mockRestore(),
      () => failure.mockRestore(),
    );

    await expect(service.startEventListening()).rejects.toBe(error);
    expect(failure).toHaveBeenCalledWith(expect.any(String), error);
  });

  test("does not subscribe twice while already listening", async () => {
    const service = await createService();
    const listening = spyOn(service.events, "isListening").mockReturnValue(true);
    const start = spyOn(service.events, "startListening");
    restores.push(
      () => listening.mockRestore(),
      () => start.mockRestore(),
    );

    await service.startEventListening();

    expect(start).not.toHaveBeenCalled();
  });
});

describe("OracleService completion retry timers", () => {
  test("ends a recovery cooldown when its timer fires", async () => {
    const service = await createService();
    const gameAddress = newAddress();
    const callbacks = captureTimers();
    const info = spyOn(logger, "info").mockImplementation(() => {});
    restores.push(() => info.mockRestore());
    const retries = (service as any).completionRetries as Map<string, unknown>;

    (service as any).installCompletionCooldown(gameAddress, undefined, "scan", 3, Date.now() + 1);
    expect(retries.get(gameAddress)).toMatchObject({ phase: "cooldown", attempt: 3 });

    callbacks[0]!();

    expect(retries.has(gameAddress)).toBe(false);
    expect(info).toHaveBeenCalledWith(
      `✅ Completion cooldown ended for ${gameAddress}; awaiting the next recovery trigger.`,
    );
  });

  test("ignores a stale cooldown timer after the entry was replaced", async () => {
    const service = await createService();
    const gameAddress = newAddress();
    const callbacks = captureTimers();
    const retries = (service as any).completionRetries as Map<string, unknown>;

    (service as any).installCompletionCooldown(gameAddress, undefined, "scan", 1, Date.now() + 1);
    const replacement = { phase: "active", attempt: 0 };
    retries.set(gameAddress, replacement);
    callbacks[0]!();

    expect(retries.get(gameAddress)).toBe(replacement);
  });

  test("runs readiness retries with descriptive logs and reports rejections", async () => {
    const service = await createService();
    const gameAddress = seedGame();
    const callbacks = captureTimers();
    const warning = spyOn(logger, "warning").mockImplementation(() => {});
    restores.push(() => warning.mockRestore());
    const retries = (service as any).completionRetries as Map<string, unknown>;
    retries.set(gameAddress, {
      phase: "active",
      attempt: 0,
      mode: "readiness",
      transientAttempt: 0,
      readinessAttempt: 0,
      trigger: "player joined",
    });

    (service as any).scheduleReadinessRetry(gameAddress, undefined, "player joined", 1);
    expect(callbacks).toHaveLength(1);

    const failure = new Error("retry exploded");
    const start = spyOn(service as any, "startAutomaticCompletionAttempt").mockRejectedValue(
      failure,
    );
    restores.push(() => start.mockRestore());
    callbacks[0]!();
    await flush();

    expect(start).toHaveBeenCalledTimes(1);
    const [options, trigger, attempt, admission] = start.mock.calls[0]! as [
      {
        gameAddress: string;
        successLog: () => string;
        failureLog: (address: string, error?: string) => string;
      },
      string,
      number,
      unknown,
    ];
    expect(options.gameAddress).toBe(gameAddress);
    expect(trigger).toBe("player joined readiness retry 1");
    expect(attempt).toBe(1);
    expect(admission).toEqual({ retryMode: "readiness" });
    expect(options.successLog()).toBe(
      `🎯 Auto-completed game ${gameAddress} after player joined readiness retry`,
    );
    expect(options.failureLog(gameAddress)).toBe(
      "❌ Auto-completion failed after player joined readiness retry: Unknown error",
    );
    expect(warning).toHaveBeenCalledWith(`Readiness retry failed for ${gameAddress}:`, failure);
    (service as any).cancelCompletionRetry(gameAddress);
  });
});
