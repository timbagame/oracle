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
  registrySyncTimeoutMs?: number;
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
    this.scheduleRetryTimeout = options.setTimeoutFn ?? setTimeout;
    this.clearRetryTimeout = options.clearTimeoutFn ?? ((timer) => clearTimeout(timer));
    this.registrySyncRetryDelayMs =
      options.registrySyncRetryDelayMs ?? DEFAULT_REGISTRY_SYNC_RETRY_DELAY_MS;
    if (options.syncPlayerRegistry) {
      this.registrySyncScheduler = new RegistrySyncScheduler(
        options.syncPlayerRegistry,
        this.registrySyncRetryDelayMs,
        (callback, delay) => this.scheduleRetryTimeout(callback, delay),
        (timer) => this.clearRetryTimeout(timer),
        options.registrySyncTimeoutMs,
      );
    }
  }

  public clearRegistrySyncs(): void {
    this.registrySyncScheduler?.clearAll();
  }

  private processingQueues = new Map<string, Promise<void>>();

  private async runEventMutation(
    eventType: string,
    handler: () => void | Promise<void>,
    gameAddress?: string,
  ): Promise<void> {
    if (!gameAddress) {
      try {
        await handler();
      } catch (error) {
        logger.failure(`Error in ${eventType} event:`, error);
      }
      return;
    }

    const previous = this.processingQueues.get(gameAddress) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await handler();
      } catch (error) {
        logger.failure(`Error in ${eventType} event for ${gameAddress}:`, error);
      }
    });
    this.processingQueues.set(gameAddress, next);
    return next;
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
      await Promise.all(
        this.options.config.map(async (handlerConfig) => {
          const listenerId = await this.options.getProgram().addEventListener(
            handlerConfig.event,
            handlerConfig.createHandler({
              handlePlayerEvent: (action, evt) => this.handlePlayerEvent(action, evt),
              handleGameInitialized: (evt) => this.handleGameInitialized(evt),
              handleGameStatusChange: (status, evt) => this.handleGameStatusChange(status, evt),
            }),
          );
          listenerIds.push(listenerId);
        }),
      );
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
    }, gameAddress);
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

    // Execute synchronously as these don't have race conditions with player events
    if (status === "completed") {
      this.options.db.markGameCompleted(gameAddress);
      this.options.onGameFinalized?.(gameAddress);
      return;
    }

    this.options.db.markGameClosed(gameAddress);
    this.options.db.clearStalePlayersForGame(gameAddress);
    logger.info(`🚫 Game closed: ${gameAddress}`);
    this.options.onGameFinalized?.(gameAddress);
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

    // Execute synchronously as these don't have race conditions with player events
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
    const analysis = analyzeRegistryState(stats, expectedTickets);

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
    if (!this.registrySyncScheduler) {
      return;
    }

    this.registrySyncScheduler.schedule({
      gameAddress: options.gameAddress,
      expectedTickets: options.expectedTickets,
      trigger: options.trigger,
      gameKey: options.gameKey,
    });
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
  timerPending?: boolean;
}

class RegistrySyncScheduler {
  private readonly entries = new Map<string, RegistrySyncEntry>();

  constructor(
    private readonly syncFn: (options: RegistrySyncScheduleOptions) => Promise<boolean>,
    private readonly retryDelayMs: number,
    private readonly setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>,
    private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void,
    private readonly syncTimeoutMs: number = 30000,
  ) {}

  public schedule(options: RegistrySyncScheduleOptions): void {
    const entry = this.entries.get(options.gameAddress) ?? {
      queue: [],
      running: false,
    };

    const normalized = this.normalizeOptions(options);

    if (entry.retryPending && entry.timerPending) {
      entry.retryPending = this.mergeScheduleOptions(entry.retryPending, normalized);
      this.entries.set(options.gameAddress, entry);
      return;
    }

    if (entry.running) {
      entry.queue.push(normalized);
      this.entries.set(options.gameAddress, entry);
      return;
    }

    entry.queue.push(normalized);
    this.entries.set(options.gameAddress, entry);
    void this.processQueue(options.gameAddress, entry);
  }

  private normalizeOptions(options: RegistrySyncScheduleOptions): RegistrySyncScheduleOptions {
    return { ...options };
  }

  private mergeScheduleOptions(
    current: RegistrySyncScheduleOptions,
    incoming: RegistrySyncScheduleOptions,
  ): RegistrySyncScheduleOptions {
    return {
      ...current,
      ...incoming,
      expectedTickets: incoming.expectedTickets ?? current.expectedTickets,
      gameKey: incoming.gameKey ?? current.gameKey,
      trigger: incoming.trigger,
    };
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
          if (this.syncTimeoutMs <= 0) {
            success = await this.syncFn(next);
          } else {
            // Add timeout
            let timerId: ReturnType<typeof setTimeout> | undefined;

            try {
              success = await Promise.race([
                this.syncFn(next),
                new Promise<boolean>((_, reject) => {
                   timerId = this.setTimer(() => {
                     reject(new Error("Registry sync timeout"));
                   }, this.syncTimeoutMs);
                })
              ]);
            } finally {
              if (timerId !== undefined) {
                this.clearTimer(timerId);
              }
            }
          }
        } catch (error) {
          logger.warn(`Registry sync failed or timed out for ${gameAddress}:`, error);
          success = false;
        }

        if (!success) {
          // Schedule retry
          // We need to set a timer to retry
          // But we also need to handle new requests coming in during the delay
          // So we set retryPending in the entry

          // If we already have a timer pending, we don't need another one?
          // But processQueue is exiting.
          // So we need to set a timer that will call processQueue again.

          entry.running = false;
          entry.timerPending = true;

          // Store the failed options as retryPending if not already set
          if (!entry.retryPending) {
             entry.retryPending = next;
          } else {
             entry.retryPending = this.mergeScheduleOptions(entry.retryPending, next);
          }
          this.entries.set(gameAddress, entry);

          this.setTimer(() => {
            const current = this.entries.get(gameAddress);
            if (!current) return;

            current.timerPending = false;

            // Move retryPending to queue
            if (current.retryPending) {
               current.queue.unshift(current.retryPending);
               current.retryPending = undefined;
            }

            this.entries.set(gameAddress, current);
            void this.processQueue(gameAddress, current);
          }, this.retryDelayMs);

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
        // The retry logic is now handled inline, so we don't need to call scheduleRetryTimer here.
        // The timer is set directly in the `if (!success)` block.
        // If there's a retryPending, it means a timer has already been set to re-process.
        // So we just return.
        return;
      }
      if (entry.queue.length === 0 && entry.timer === undefined) {
        this.entries.delete(gameAddress);
      }
    }
  }


  public hasPendingEntry(gameAddress: string): boolean {
    return this.entries.has(gameAddress);
  }

  public clearAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) {
        this.clearTimer(entry.timer);
      }
    }
    this.entries.clear();
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

export { RegistrySyncScheduler };
