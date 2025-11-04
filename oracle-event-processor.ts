import type * as anchor from "@coral-xyz/anchor";
import type { Timba } from "./idl/idlType.ts";
import type { OracleDatabase } from "./database.ts";
import type { TimbaEventMap, TimbaEvent, TimbaPlayerEvent, TimbaGameStatusEvent, TimbaGameInitializedEvent } from "./types/timba.ts";
import type { PublicKeyLike } from "./solana-utils.ts";
import type { EventHandlerConfig } from "./oracle-service.types.ts";
import { toBase58, resolveNumericLike, coercePublicKey } from "./solana-utils.ts";
import { logger } from "./logger.ts";

const GAME_TYPE_MAX_LENGTH = 128;

export interface OracleEventProcessorOptions {
  getProgram: () => anchor.Program<Timba>;
  db: OracleDatabase;
  tryAutoComplete: (gameKey: PublicKeyLike | undefined, gameAddress: string, trigger: string) => Promise<void>;
  config: ReadonlyArray<EventHandlerConfig<keyof TimbaEventMap>>;
  clearTokenProgramCache: () => void;
}

export class OracleEventProcessor {
  private listenerIds: number[] = [];
  private listening = false;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly options: OracleEventProcessorOptions) {}

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

    await this.runEventMutation(eventType, async () => {
      if (action === "joined") {
        this.options.db.addPlayerToGame(gameAddress, playerAddress!, ticketIndex!);
      } else {
        this.options.db.removePlayerFromGame(gameAddress, ticketIndex!);
      }

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
        return;
      }

      this.options.db.markGameClosed(gameAddress);
      this.options.db.clearStalePlayersForGame(gameAddress);
      logger.info(`🚫 Game closed: ${gameAddress}`);
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
          const normalized = gameTypeKeys[0].toLowerCase();
          if (normalized.length > GAME_TYPE_MAX_LENGTH) {
            logger.warn(
              `⚠️  Truncating game type for ${gameAddress}; received ${normalized.length} characters`,
            );
            gameType = normalized.slice(0, GAME_TYPE_MAX_LENGTH);
          } else {
            gameType = normalized;
          }
        }
      }

      logger.info(`🎮 Game initialized: ${gameAddress}, Type: ${gameType || "unknown"}`);
      this.options.db.trackGame(gameAddress, gameType, { preserveFinalized: true });
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
