import type * as anchor from "@coral-xyz/anchor";
import type { Timba } from "./idl/idlType.ts";
import type { OracleDatabase } from "./database.ts";
import type { TimbaEventMap, TimbaEvent, TimbaPlayerEvent, TimbaGameStatusEvent, TimbaGameInitializedEvent } from "./types/timba.ts";
import type { PublicKeyLike } from "./solana-utils.ts";
import type { EventHandlerConfig } from "./oracle-service.types.ts";
import { toBase58, resolveNumericLike, coercePublicKey } from "./solana-utils.ts";
import { normalizeGameType } from "./game-type.ts";
import { logger } from "./logger.ts";
import { analyzeRegistryState } from "./player-registry-utils.ts";

const DEFAULT_REGISTRY_SYNC_RETRY_DELAY_MS = 2000;

export interface OracleEventProcessorOptions {
  getProgram: () => anchor.Program<Timba>;
  db: OracleDatabase;
  tryAutoComplete: (gameKey: PublicKeyLike | undefined, gameAddress: string, trigger: string) => Promise<void>;
  config: ReadonlyArray<EventHandlerConfig<keyof TimbaEventMap>>;
  clearTokenProgramCache: () => void;
  syncPlayerRegistry?: (options: {
    gameAddress: string;
    expectedTickets?: number;
    trigger: string;
    gameKey?: PublicKeyLike;
  }) => Promise<boolean>;
  onGameFinalized?: (gameAddress: string) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  registrySyncRetryDelayMs?: number;
}

export class OracleEventProcessor {
  private listenerIds: number[] = [];
  private listening = false;
  private startPromise: Promise<void> | null = null;
  private readonly registrySyncScheduler?: RegistrySyncScheduler;
  private readonly registrySyncRetryDelayMs: number;
  public scheduleRetryTimeout: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  public clearRetryTimeout: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly options: OracleEventProcessorOptions) {
    this.scheduleRetryTimeout =
      options.setTimeoutFn ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearRetryTimeout =
      options.clearTimeoutFn ?? ((timer) => clearTimeout(timer));
    this.registrySyncRetryDelayMs =
      options.registrySyncRetryDelayMs ?? DEFAULT_REGISTRY_SYNC_RETRY_DELAY_MS;
    if (options.syncPlayerRegistry) {
      this.registrySyncScheduler = new RegistrySyncScheduler(
        options.syncPlayerRegistry,
        this.registrySyncRetryDelayMs,
        (...args) => this.scheduleRetryTimeout(...args),
        (timer) => this.clearRetryTimeout(timer),
      );
    }
  }

  private async runEventMutation(
    eventType: string,
    handler: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await handler();
    } catch (error) {
      logger.failure(`Error in ${eventType} event:`, error);
    }
  }

  public async startListening(): Promise<void> {
    if (this.listening) {
      return;
    }

    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    logger.info("🎧 Starting event listeners...");

    this.startPromise = (async () => {
      this.listening = true;
      try {
        this.listenerIds = await this.setupEventListeners();
      } catch (error) {
        this.listening = false;
        this.listenerIds = [];
        throw error;
      }
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  public async setupEventListeners(): Promise<number[]> {
    const listenerIds: number[] = [];

    try {
      const program = this.options.getProgram();
      for (const { event, createHandler } of this.options.config) {
        const handler = createHandler({
          handlePlayerEvent: (action, evt) => this.handlePlayerEvent(action, evt),
          handleGameInitialized: (evt) => this.handleGameInitialized(evt),
          handleGameStatusChange: (status, evt) => this.handleGameStatusChange(status, evt),
        });

        const listenerId = await program.addEventListener(event, handler);
        listenerIds.push(listenerId);
      }

      return listenerIds;
    } catch (error) {
      const program = this.options.getProgram();
      await Promise.allSettled(
        listenerIds.map((listenerId) => program.removeEventListener(listenerId))
      );
      throw error;
    }
  }

  public async stopListening(): Promise<void> {
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // ignore errors from a failed startup; stop flow will still clean up
      }
    }

    if (!this.listening) {
      return;
    }

    const program = this.options.getProgram();
    await Promise.allSettled(
      this.listenerIds.map((listenerId) => program.removeEventListener(listenerId))
    );

    this.listenerIds = [];
    this.listening = false;
    this.options.clearTokenProgramCache();
  }

  public isListening(): boolean {
    return this.listening;
  }

  public getActiveListenerCount(): number {
    return this.listenerIds.length;
  }

  public async handlePlayerEvent(
    action: "joined" | "unjoined",
    event: TimbaPlayerEvent,
  ): Promise<void> {
    const eventData = this.extractEventData(event);
    const eventType = `player ${action}`;
    const validation = this.validateEventData(eventData, eventType, {
      requireTicketIndex: true,
      requirePlayerAddress: action === "joined",
      requireValidGameAddress: true,
    });

    if (!validation.valid) {
      logger.warn(validation.message);
      return;
    }

    const { gameAddress, playerAddress, ticketIndex } = eventData;
    const expectedTickets = resolveNumericLike(
      (event as Record<string, unknown>)["ticketsCount"] ??
        (event as Record<string, unknown>)["tickets_count"],
    );

    await this.runEventMutation(eventType, async () => {
      if (action === "joined") {
        this.options.db.addPlayerToGame(gameAddress, playerAddress!, ticketIndex!);
      } else {
        this.options.db.removePlayerFromGame(gameAddress, ticketIndex!);
      }

      void this.evaluateRegistryConsistency(
        gameAddress,
        expectedTickets,
        eventType,
        event.gameKey,
      );

      await this.options.tryAutoComplete(event.gameKey, gameAddress, action);
    });
  }

  public handleGameStatusChange(
    status: "completed" | "closed",
    event: TimbaGameStatusEvent,
  ): void {
    const eventData = this.extractEventData(event);
    const eventType = `game ${status}`;
    const validation = this.validateEventData(eventData, eventType, {
      requireValidGameAddress: true,
    });

    if (!validation.valid) {
      logger.warn(validation.message);
      return;
    }

    const { gameAddress } = eventData;
    void this.runEventMutation(eventType, async () => {
      if (status === "completed") {
        this.options.db.markGameCompleted(gameAddress);
        this.options.onGameFinalized?.(gameAddress);
        return;
      }

      this.options.db.markGameClosed(gameAddress);
      this.options.db.clearStalePlayersForGame(gameAddress);
      logger.info(`🚫 Game closed: ${gameAddress}`);
      this.options.onGameFinalized?.(gameAddress);
    });
  }

  public handleGameInitialized(event: TimbaGameInitializedEvent): void {
    const eventData = this.extractEventData(event);
    const eventType = "game initialized";
    const validation = this.validateEventData(eventData, eventType, {
      requireValidGameAddress: true,
    });

    if (!validation.valid) {
      logger.warn(validation.message);
      return;
    }

    const { gameAddress } = eventData;

    void this.runEventMutation(eventType, () => {
      let gameType: string | undefined = undefined;
      if (event.gameType) {
        const gameTypeKeys = Object.keys(event.gameType);
        if (gameTypeKeys.length > 0 && gameTypeKeys[0]) {
          const normalized = normalizeGameType(gameTypeKeys[0], { allowTruncate: true });
          if (normalized.value) {
            if (normalized.truncated) {
              logger.warn(
                `⚠️  Truncating game type for ${gameAddress}; received ${normalized.originalLength ?? "more than allowed"} characters`,
              );
            }
            gameType = normalized.value;
          }
        }
      }

      logger.info(`🎮 Game initialized: ${gameAddress}, Type: ${gameType || "unknown"}`);
      this.options.db.trackGame(gameAddress, gameType, { preserveFinalized: true });
    });
  }

  private async evaluateRegistryConsistency(
    gameAddress: string,
    expectedTickets: number | undefined,
    trigger: string,
    gameKey?: PublicKeyLike,
  ): Promise<void> {
    if (!this.options.syncPlayerRegistry) {
      return;
    }

    const stats = this.options.db.getPlayerTicketStats(gameAddress);
    const analysis = analyzeRegistryState(
      {
        count: stats.count,
        maxIndex: stats.maxIndex,
        minIndex: stats.minIndex,
      },
      expectedTickets,
    );

    if (!analysis.needsReconciliation) {
      return;
    }

    void this.schedulePlayerRegistrySync({
      gameAddress,
      expectedTickets: analysis.normalizedExpected,
      trigger,
      gameKey,
    });
  }

  private schedulePlayerRegistrySync(options: {
    gameAddress: string;
    expectedTickets?: number;
    trigger: string;
    gameKey?: PublicKeyLike;
  }): void {
    this.registrySyncScheduler?.schedule(options);
  }

  private validateEventData(
    eventData: { gameAddress: string; playerAddress?: string; ticketIndex?: number },
    eventType: string,
    options: {
      requireTicketIndex?: boolean;
      requirePlayerAddress?: boolean;
      requireValidGameAddress?: boolean;
    } = {}
  ): { valid: boolean; message?: string } {
    if (!eventData.gameAddress) {
      return {
        valid: false,
        message: `⚠️  Missing game address in ${eventType} event`,
      };
    }

    if (options.requireValidGameAddress && !coercePublicKey(eventData.gameAddress)) {
      return {
        valid: false,
        message: `⚠️  Invalid game address in ${eventType} event for ${eventData.gameAddress}`,
      };
    }

    if (options.requireTicketIndex) {
      if (eventData.ticketIndex === undefined) {
        return {
          valid: false,
          message: `⚠️  Missing ticket index in ${eventType} event for ${eventData.gameAddress}`,
        };
      }

      if (
        !Number.isSafeInteger(eventData.ticketIndex) ||
        eventData.ticketIndex < 0
      ) {
        return {
          valid: false,
          message: `⚠️  Invalid ticket index ${eventData.ticketIndex} in ${eventType} event for ${eventData.gameAddress}`,
        };
      }
    }

    if (options.requirePlayerAddress && !eventData.playerAddress) {
      return {
        valid: false,
        message: `⚠️  Missing player address in ${eventType} event for ${eventData.gameAddress}`,
      };
    }

    return { valid: true };
  }

  public extractEventData(event: TimbaEvent): { gameAddress: string; playerAddress?: string; ticketIndex?: number } {
    const gameKey = (event.gameKey ?? event.gameAddress ?? event.game) as PublicKeyLike | undefined;
    const playerKey = (event.player ?? event.playerAddress) as PublicKeyLike | undefined;

    return {
      gameAddress: gameKey ? toBase58(gameKey) ?? "" : "",
      playerAddress: playerKey ? toBase58(playerKey) : undefined,
      ticketIndex: resolveNumericLike(event.ticketIndex ?? event.ticket_index),
    };
  }
}

type RegistrySyncScheduleOptions = Parameters<
  NonNullable<OracleEventProcessorOptions["syncPlayerRegistry"]>
>[0];

interface RegistrySyncEntry {
  queue: RegistrySyncScheduleOptions[];
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
  retryPending?: RegistrySyncScheduleOptions;
}

class RegistrySyncScheduler {
  private readonly entries = new Map<string, RegistrySyncEntry>();

  constructor(
    private readonly syncFn: (options: RegistrySyncScheduleOptions) => Promise<boolean>,
    private readonly retryDelayMs: number,
    private readonly setTimer: typeof setTimeout,
    private readonly clearTimer: typeof clearTimeout,
  ) {}

  public schedule(options: RegistrySyncScheduleOptions): void {
    const entry = this.entries.get(options.gameAddress) ?? {
      queue: [],
      running: false,
    };
    if (entry.running || entry.queue.length > 0) {
      this.entries.set(options.gameAddress, entry);
      return;
    }
    entry.queue.push(options);

    if (!entry.running && entry.timer === undefined) {
      void this.processQueue(options.gameAddress, entry);
    }

    this.entries.set(options.gameAddress, entry);
  }

  private async processQueue(gameAddress: string, entry: RegistrySyncEntry): Promise<void> {
    if (entry.running) {
      return;
    }

    entry.running = true;

    try {
      while (entry.queue.length > 0) {
        const next = entry.queue.shift()!;
        let success = false;

        try {
          success = await this.syncFn(next);
        } catch {
          success = false;
        }

        if (!success) {
          entry.retryPending = next;
          entry.queue.length = 0;
          return;
        }

        if (entry.timer !== undefined) {
          this.clearTimer(entry.timer);
          entry.timer = undefined;
        }
      }
    } finally {
      entry.running = false;
      if (entry.retryPending) {
        this.scheduleRetryTimer(gameAddress, entry);
        return;
      }
      if (entry.queue.length === 0 && entry.timer === undefined) {
        this.entries.delete(gameAddress);
      }
    }
  }

  private scheduleRetryTimer(gameAddress: string, entry: RegistrySyncEntry): void {
    if (entry.timer !== undefined) {
      return;
    }

    entry.timer = this.setTimer(() => {
      entry.timer = undefined;
      if (entry.retryPending) {
        entry.queue.push(entry.retryPending);
        entry.retryPending = undefined;
      }

      if (!entry.running) {
        void this.processQueue(gameAddress, entry);
      }
    }, this.retryDelayMs);
  }

  public hasPendingEntry(gameAddress: string): boolean {
    return this.entries.has(gameAddress);
  }
}

export const EVENT_HANDLER_CONFIG: ReadonlyArray<EventHandlerConfig<keyof TimbaEventMap>> = [
  {
    event: "playerJoined",
    createHandler: (ctx) => (event) => ctx.handlePlayerEvent("joined", event),
  },
  {
    event: "playerUnjoined",
    createHandler: (ctx) => (event) => ctx.handlePlayerEvent("unjoined", event),
  },
  {
    event: "gameInitialized",
    createHandler: (ctx) => (event) => ctx.handleGameInitialized(event),
  },
  {
    event: "gameCompleted",
    createHandler: (ctx) => (event) => ctx.handleGameStatusChange("completed", event),
  },
  {
    event: "gameClosed",
    createHandler: (ctx) => (event) => ctx.handleGameStatusChange("closed", event),
  },
];
