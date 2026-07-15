import type * as anchor from "@anchor-lang/core";
import type { Timba } from "./idl/idlType.ts";
import type { OracleDatabase } from "./database.ts";
import type {
  TimbaEventMap,
  TimbaEvent,
  TimbaPlayerEvent,
  TimbaGameStatusEvent,
  TimbaGameInitializedEvent,
} from "./types/timba.ts";
import type { PublicKeyLike } from "./solana-utils.ts";
import type { EventHandlerConfig } from "./oracle-service.types.ts";
import { toBase58, resolveNumericLike, coercePublicKey } from "./solana-utils.ts";
import { normalizeGameType } from "./game-type.ts";
import { logger } from "./logger.ts";
import { analyzeRegistryState } from "./player-registry-utils.ts";

const DEFAULT_REGISTRY_SYNC_RETRY_DELAY_MS = 2000;
const DEFAULT_PLAYER_EVENT_FLUSH_DEBOUNCE_MS = 100;
const DEFAULT_PLAYER_EVENT_FLUSH_MAX_OPERATIONS = 500;
const DEFAULT_AUTOCOMPLETE_DEBOUNCE_MS = 500;

export interface OracleEventProcessorOptions {
  getProgram: () => anchor.Program<Timba>;
  db: OracleDatabase;
  tryAutoComplete: (
    gameKey: PublicKeyLike | undefined,
    gameAddress: string,
    trigger: string,
  ) => Promise<void>;
  config: ReadonlyArray<EventHandlerConfig<keyof TimbaEventMap>>;
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
  playerEventFlushDebounceMs?: number;
  playerEventFlushMaxOperations?: number;
  autoCompleteDebounceMs?: number;
}

type PlayerMutation =
  | { action: "joined"; playerAddress: string; ticketIndex: number }
  | { action: "unjoined"; ticketIndex: number; movedParticipant?: string };

type PendingPlayerMutationBuffer = {
  operations: PlayerMutation[];
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
  expectedTickets?: number;
  lastGameKey?: PublicKeyLike;
  lastTrigger?: string;
};

type PendingAutoCompleteState = {
  pending: boolean;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
  gameKey?: PublicKeyLike;
  trigger?: string;
};

export class OracleEventProcessor {
  private listenerIds: number[] = [];
  private listening = false;
  private startPromise: Promise<void> | null = null;
  private readonly registrySyncScheduler?: RegistrySyncScheduler;
  private readonly registrySyncRetryDelayMs: number;
  private readonly playerEventFlushDebounceMs: number;
  private readonly playerEventFlushMaxOperations: number;
  private readonly autoCompleteDebounceMs: number;
  private readonly playerMutationBuffers = new Map<string, PendingPlayerMutationBuffer>();
  private readonly pendingAutoCompletes = new Map<string, PendingAutoCompleteState>();
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
    const isTestEnv = (process.env["NODE_ENV"] ?? "").toLowerCase() === "test";
    this.playerEventFlushDebounceMs =
      options.playerEventFlushDebounceMs ??
      (isTestEnv ? 0 : DEFAULT_PLAYER_EVENT_FLUSH_DEBOUNCE_MS);
    this.playerEventFlushMaxOperations =
      options.playerEventFlushMaxOperations ?? DEFAULT_PLAYER_EVENT_FLUSH_MAX_OPERATIONS;
    this.autoCompleteDebounceMs =
      options.autoCompleteDebounceMs ?? (isTestEnv ? 0 : DEFAULT_AUTOCOMPLETE_DEBOUNCE_MS);
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

  private hasActiveSecretKey(gameAddress: string): boolean {
    try {
      return Boolean(this.options.db.getSecretKey(gameAddress));
    } catch {
      return false;
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

    const existing = this.processingQueues.get(gameAddress);

    // Fast path: no pending work for this game; execute immediately to keep
    // synchronous expectations in tests while still registering async work.
    if (!existing) {
      try {
        const result = handler();
        if (result && typeof (result as Promise<unknown>).then === "function") {
          const inFlight = (result as Promise<void>)
            .catch((error) => {
              logger.failure(`Error in ${eventType} event for ${gameAddress}:`, error);
            })
            .finally(() => {
              if (this.processingQueues.get(gameAddress) === inFlight) {
                this.processingQueues.delete(gameAddress);
              }
            });
          this.processingQueues.set(gameAddress, inFlight);
          return inFlight;
        }
        return;
      } catch (error) {
        logger.failure(`Error in ${eventType} event for ${gameAddress}:`, error);
        return;
      }
    }

    // Slow path: queue behind existing work for the same game
    const next = existing.then(async () => {
      try {
        await handler();
      } catch (error) {
        logger.failure(`Error in ${eventType} event for ${gameAddress}:`, error);
      }
    });
    this.processingQueues.set(gameAddress, next);
    return next.finally(() => {
      if (this.processingQueues.get(gameAddress) === next) {
        this.processingQueues.delete(gameAddress);
      }
    });
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
      for (const handlerConfig of this.options.config) {
        const listenerId = await this.options.getProgram().addEventListener(
          handlerConfig.event,
          handlerConfig.createHandler({
            handlePlayerEvent: (action, evt) => this.handlePlayerEvent(action, evt),
            handleGameInitialized: (evt) => this.handleGameInitialized(evt),
            handleGameStatusChange: (status, evt) => this.handleGameStatusChange(status, evt),
          }),
        );
        listenerIds.push(listenerId);
      }
      return listenerIds;
    } catch (error) {
      const program = this.options.getProgram();
      await Promise.allSettled(
        listenerIds.map((listenerId) => program.removeEventListener(listenerId)),
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
      this.listenerIds.map((listenerId) => program.removeEventListener(listenerId)),
    );

    this.listenerIds = [];
    this.listening = false;
    this.clearRegistrySyncs();
    this.clearBufferedPlayerMutations();
    this.clearAutoCompleteSchedules();
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

    const { gameAddress, playerAddress, ticketIndex, movedParticipant } = eventData;
    if (!this.hasActiveSecretKey(gameAddress)) {
      // Hardening: ignore on-chain activity for games that the oracle did not
      // issue secrets for (prevents DB growth from spam/invalid games).
      return;
    }

    const expectedTickets = resolveNumericLike(
      (event as Record<string, unknown>)["ticketsCount"] ??
        (event as Record<string, unknown>)["tickets_count"],
    );

    await this.runEventMutation(
      eventType,
      async () => {
        const mutation: PlayerMutation =
          action === "joined"
            ? { action: "joined", playerAddress: playerAddress!, ticketIndex: ticketIndex! }
            : { action: "unjoined", ticketIndex: ticketIndex!, movedParticipant };
        await this.enqueuePlayerMutation(gameAddress, mutation, {
          expectedTickets,
          gameKey: event.gameKey,
          trigger: action,
        });
      },
      gameAddress,
    );
  }

  public handleGameStatusChange(status: "completed" | "closed", event: TimbaGameStatusEvent): void {
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
    if (!this.hasActiveSecretKey(gameAddress)) {
      // Hardening: ignore status events for games the oracle did not issue secrets for.
      return;
    }

    const flushPromise = this.flushPlayerMutationBuffer(gameAddress, {
      trigger: `game ${status}`,
      gameKey: event.gameKey,
    });

    if (!flushPromise) {
      void this.runEventMutation(
        `game ${status}`,
        () => {
          if (status === "completed") {
            this.options.db.markGameCompleted(gameAddress);
            this.cancelAutoComplete(gameAddress);
            this.options.onGameFinalized?.(gameAddress);
            return;
          }

          this.options.db.markGameClosed(gameAddress);
          this.options.db.clearStalePlayersForGame(gameAddress);
          logger.info(`🚫 Game closed: ${gameAddress}`);
          this.cancelAutoComplete(gameAddress);
          this.options.onGameFinalized?.(gameAddress);
        },
        gameAddress,
      );
      return;
    }

    void this.runEventMutation(
      `game ${status}`,
      async () => {
        await flushPromise;
        // Serialize with player mutations to keep per-game ordering consistent.
        if (status === "completed") {
          this.options.db.markGameCompleted(gameAddress);
          this.cancelAutoComplete(gameAddress);
          this.options.onGameFinalized?.(gameAddress);
          return;
        }

        this.options.db.markGameClosed(gameAddress);
        this.options.db.clearStalePlayersForGame(gameAddress);
        logger.info(`🚫 Game closed: ${gameAddress}`);
        this.cancelAutoComplete(gameAddress);
        this.options.onGameFinalized?.(gameAddress);
      },
      gameAddress,
    );
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
    if (!this.hasActiveSecretKey(gameAddress)) {
      // Hardening: never create tracking rows based on on-chain events alone.
      // Only games with a stored (unused) secret key are tracked.
      return;
    }

    this.options.db.markSecretKeyCommitted(gameAddress);

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

  private clearBufferedPlayerMutations(): void {
    for (const entry of this.playerMutationBuffers.values()) {
      if (entry.timer) {
        this.clearRetryTimeout(entry.timer);
      }
    }
    this.playerMutationBuffers.clear();
  }

  private clearAutoCompleteSchedules(): void {
    for (const entry of this.pendingAutoCompletes.values()) {
      if (entry.timer) {
        this.clearRetryTimeout(entry.timer);
      }
    }
    this.pendingAutoCompletes.clear();
  }

  private cancelAutoComplete(gameAddress: string): void {
    const entry = this.pendingAutoCompletes.get(gameAddress);
    if (!entry) {
      return;
    }
    if (entry.timer) {
      this.clearRetryTimeout(entry.timer);
      entry.timer = undefined;
    }
    this.pendingAutoCompletes.delete(gameAddress);
  }

  private scheduleAutoComplete(
    gameAddress: string,
    options: { gameKey?: PublicKeyLike; trigger?: string } = {},
  ): Promise<void> | void {
    const entry = this.pendingAutoCompletes.get(gameAddress) ?? {
      pending: false,
      running: false,
    };

    entry.pending = true;
    entry.gameKey = options.gameKey ?? entry.gameKey;
    entry.trigger = options.trigger ?? entry.trigger;

    if (entry.running) {
      this.pendingAutoCompletes.set(gameAddress, entry);
      return;
    }

    if (this.autoCompleteDebounceMs <= 0) {
      this.pendingAutoCompletes.set(gameAddress, entry);
      return this.flushAutoComplete(gameAddress);
    }

    if (entry.timer) {
      this.pendingAutoCompletes.set(gameAddress, entry);
      return;
    }

    entry.timer = this.scheduleRetryTimeout(() => {
      void this.flushAutoComplete(gameAddress);
    }, this.autoCompleteDebounceMs);
    this.pendingAutoCompletes.set(gameAddress, entry);
  }

  private async flushAutoComplete(gameAddress: string): Promise<void> {
    const entry = this.pendingAutoCompletes.get(gameAddress);
    if (!entry) {
      return;
    }

    if (entry.timer) {
      this.clearRetryTimeout(entry.timer);
      entry.timer = undefined;
    }

    if (!entry.pending || entry.running) {
      return;
    }

    entry.pending = false;
    entry.running = true;
    this.pendingAutoCompletes.set(gameAddress, entry);

    try {
      await this.options.tryAutoComplete(entry.gameKey, gameAddress, entry.trigger ?? "batch");
    } catch (error) {
      logger.failure(`Auto-complete attempt failed for ${gameAddress}:`, error);
    } finally {
      entry.running = false;
      if (entry.pending) {
        this.pendingAutoCompletes.set(gameAddress, entry);
        await this.flushAutoComplete(gameAddress);
        return;
      }
      this.pendingAutoCompletes.delete(gameAddress);
    }
  }

  private enqueuePlayerMutation(
    gameAddress: string,
    mutation: PlayerMutation,
    options: { expectedTickets?: number; gameKey?: PublicKeyLike; trigger: string },
  ): Promise<void> | void {
    const entry = this.playerMutationBuffers.get(gameAddress) ?? {
      operations: [],
      running: false,
    };

    entry.operations.push(mutation);
    entry.lastGameKey = options.gameKey ?? entry.lastGameKey;
    entry.lastTrigger = options.trigger;
    if (typeof options.expectedTickets === "number" && Number.isFinite(options.expectedTickets)) {
      entry.expectedTickets = options.expectedTickets;
    }

    const shouldFlushNow =
      this.playerEventFlushDebounceMs <= 0 ||
      entry.operations.length >= Math.max(1, this.playerEventFlushMaxOperations);

    this.playerMutationBuffers.set(gameAddress, entry);

    if (shouldFlushNow) {
      return this.flushPlayerMutationBufferSerialized(gameAddress, {
        trigger: options.trigger,
        gameKey: entry.lastGameKey,
      });
    }

    if (entry.timer) {
      return;
    }

    entry.timer = this.scheduleRetryTimeout(() => {
      void this.flushPlayerMutationBuffer(gameAddress, {
        trigger: "debounce",
        gameKey: entry.lastGameKey,
      });
    }, this.playerEventFlushDebounceMs);
    this.playerMutationBuffers.set(gameAddress, entry);
  }

  private flushPlayerMutationBuffer(
    gameAddress: string,
    options: { trigger: string; gameKey?: PublicKeyLike },
  ): Promise<void> | void {
    const entry = this.playerMutationBuffers.get(gameAddress);
    if (!entry || (entry.operations.length === 0 && !entry.running && !entry.timer)) {
      if (entry && entry.timer) {
        this.clearRetryTimeout(entry.timer);
      }
      this.playerMutationBuffers.delete(gameAddress);
      return;
    }

    return this.runEventMutation(
      "player batch flush",
      async () => {
        await this.flushPlayerMutationBufferSerialized(gameAddress, options);
      },
      gameAddress,
    );
  }

  private async flushPlayerMutationBufferSerialized(
    gameAddress: string,
    options: { trigger: string; gameKey?: PublicKeyLike },
  ): Promise<void> {
    const entry = this.playerMutationBuffers.get(gameAddress);
    if (!entry) {
      return;
    }

    if (entry.timer) {
      this.clearRetryTimeout(entry.timer);
      entry.timer = undefined;
    }

    if (entry.running) {
      return;
    }

    if (entry.operations.length === 0) {
      this.playerMutationBuffers.delete(gameAddress);
      return;
    }

    entry.running = true;
    const operations = entry.operations;
    entry.operations = [];
    const expectedTickets = entry.expectedTickets;
    entry.expectedTickets = undefined;
    const gameKey = options.gameKey ?? entry.lastGameKey;
    const trigger = options.trigger ?? entry.lastTrigger ?? "batch";
    this.playerMutationBuffers.set(gameAddress, entry);

    try {
      const applyPlayerMutations = (this.options.db as any).applyPlayerMutations as
        ((address: string, ops: ReadonlyArray<PlayerMutation>) => void) | undefined;

      if (typeof applyPlayerMutations === "function") {
        // Important: call through the db instance to preserve `this` binding for class methods.
        (this.options.db as any).applyPlayerMutations(gameAddress, operations);
      } else {
        for (const op of operations) {
          if (op.action === "joined") {
            this.options.db.addPlayerToGame(gameAddress, op.playerAddress, op.ticketIndex);
          } else {
            this.options.db.removePlayerFromGame(gameAddress, op.ticketIndex);
            if (op.movedParticipant) {
              this.options.db.removePlayerAddressFromGame?.(gameAddress, op.movedParticipant);
              this.options.db.addPlayerToGame(gameAddress, op.movedParticipant, op.ticketIndex);
            }
          }
        }
      }

      void this.evaluateRegistryConsistency(
        gameAddress,
        expectedTickets,
        trigger === "joined" || trigger === "unjoined"
          ? `player ${trigger}`
          : `player batch ${trigger}`,
        gameKey,
      );

      await this.flushMaybeAutoComplete(gameAddress, {
        gameKey,
        trigger,
      });
    } finally {
      entry.running = false;
      if (entry.operations.length > 0) {
        this.playerMutationBuffers.set(gameAddress, entry);
        await this.flushPlayerMutationBufferSerialized(gameAddress, {
          trigger: "followup",
          gameKey: entry.lastGameKey,
        });
        return;
      }

      if (entry.timer) {
        this.playerMutationBuffers.set(gameAddress, entry);
        return;
      }

      this.playerMutationBuffers.delete(gameAddress);
    }
  }

  private async flushMaybeAutoComplete(
    gameAddress: string,
    options: { gameKey?: PublicKeyLike; trigger?: string },
  ): Promise<void> {
    const scheduled = this.scheduleAutoComplete(gameAddress, options);
    if (scheduled && typeof (scheduled as Promise<void>).then === "function") {
      await scheduled;
    }
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
    eventData: {
      gameAddress: string;
      playerAddress?: string;
      ticketIndex?: number;
      movedParticipant?: string;
    },
    eventType: string,
    options: {
      requireTicketIndex?: boolean;
      requirePlayerAddress?: boolean;
      requireValidGameAddress?: boolean;
    } = {},
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

      if (!Number.isSafeInteger(eventData.ticketIndex) || eventData.ticketIndex < 0) {
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

  public extractEventData(event: TimbaEvent): {
    gameAddress: string;
    playerAddress?: string;
    ticketIndex?: number;
    movedParticipant?: string;
  } {
    const gameKey = (event.gameKey ?? event.gameAddress ?? event.game) as PublicKeyLike | undefined;
    const playerKey = (event.player ?? event.playerAddress) as PublicKeyLike | undefined;
    const movedKey = (event.movedParticipant ?? event.moved_participant) as
      PublicKeyLike | null | undefined;

    return {
      gameAddress: gameKey ? (toBase58(gameKey) ?? "") : "",
      playerAddress: playerKey ? toBase58(playerKey) : undefined,
      ticketIndex: resolveNumericLike(event.ticketIndex ?? event.ticket_index),
      movedParticipant: movedKey ? toBase58(movedKey) : undefined,
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
    private readonly setTimer: (
      callback: () => void,
      delay: number,
    ) => ReturnType<typeof setTimeout>,
    private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void,
    private readonly syncTimeoutMs: number = 30000,
  ) {}

  public schedule(options: RegistrySyncScheduleOptions): void {
    const entry = this.entries.get(options.gameAddress) ?? {
      queue: [],
      running: false,
      timerPending: false,
    };

    const normalized = this.normalizeOptions(options);

    if (entry.retryPending && entry.timerPending) {
      entry.retryPending = this.mergeScheduleOptions(entry.retryPending, normalized);
      this.entries.set(options.gameAddress, entry);
      return;
    }

    // Coalesce with the most recent queued item to avoid redundant syncs under bursty events.
    if (entry.queue.length > 0) {
      const lastIndex = entry.queue.length - 1;
      entry.queue[lastIndex] = this.mergeScheduleOptions(entry.queue[lastIndex]!, normalized);
    } else {
      entry.queue.push(normalized);
    }

    if (entry.running) {
      this.entries.set(options.gameAddress, entry);
      return;
    }

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
                }),
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

          entry.timer = this.setTimer(() => {
            const current = this.entries.get(gameAddress);
            if (!current) return;

            current.timerPending = false;
            current.timer = undefined;

            // Move retryPending to queue
            if (current.retryPending) {
              current.queue.unshift(current.retryPending);
              current.retryPending = undefined;
            }

            this.entries.set(gameAddress, current);
            void this.processQueue(gameAddress, current);
          }, this.retryDelayMs);

          // Store the failed options as retryPending if not already set
          if (!entry.retryPending) {
            entry.retryPending = next;
          } else {
            entry.retryPending = this.mergeScheduleOptions(entry.retryPending, next);
          }
          this.entries.set(gameAddress, entry);

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
