import type * as anchor from "@coral-xyz/anchor";
import type { Timba } from "./idl/idlType.ts";
import type { OracleDatabase } from "./database.ts";
import type { TimbaEventMap, TimbaEvent, TimbaPlayerEvent, TimbaGameStatusEvent, TimbaGameInitializedEvent } from "./types/timba.ts";
import type { PublicKeyLike } from "./solana-utils.ts";
import type { EventHandlerConfig } from "./oracle-service.types.ts";
import { toBase58, resolveNumericLike } from "./solana-utils.ts";

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

  constructor(private readonly options: OracleEventProcessorOptions) {}

  public async startListening(): Promise<void> {
    if (this.listening) {
      return;
    }

    console.log("🎧 Starting event listeners...");
    this.listenerIds = await this.setupEventListeners();
    this.listening = true;
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
    event: TimbaPlayerEvent
  ): Promise<void> {
    const eventData = this.extractEventData(event);

    const validation = this.validatePlayerEventData(action, eventData);
    if (!validation.valid) {
      console.warn(validation.message);
      return;
    }

    try {
      const { gameAddress, playerAddress, ticketIndex } = eventData;

      switch (action) {
        case "joined":
          this.options.db.addPlayerToGame(gameAddress, playerAddress!, ticketIndex!);
          break;
        case "unjoined":
          this.options.db.removePlayerFromGame(gameAddress, ticketIndex!);
          break;
      }

      await this.options.tryAutoComplete(event.gameKey, gameAddress, action);
    } catch (error) {
      console.error(`❌ Error in player ${action} event:`, error);
    }
  }

  public handleGameStatusChange(
    status: "completed" | "closed",
    event: TimbaGameStatusEvent
  ): void {
    const eventData = this.extractEventData(event);

    const validation = this.validateGameAddressData(eventData, `game ${status}`);
    if (!validation.valid) {
      console.warn(validation.message);
      return;
    }

    try {
      const { gameAddress } = eventData;

      if (status === "completed") {
        this.options.db.markGameCompleted(gameAddress);
      } else {
        this.options.db.markGameClosed(gameAddress);
        this.options.db.clearStalePlayersForGame(gameAddress);
        console.log(`🚫 Game closed: ${gameAddress}`);
      }
    } catch (error) {
      console.error(`❌ Error in game ${status} event:`, error);
    }
  }

  public handleGameInitialized(event: TimbaGameInitializedEvent): void {
    const eventData = this.extractEventData(event);

    const validation = this.validateGameAddressData(eventData, "game initialized");
    if (!validation.valid) {
      console.warn(validation.message);
      return;
    }

    const { gameAddress } = eventData;

    let gameType: string | undefined = undefined;
    if (event.gameType) {
      const gameTypeKeys = Object.keys(event.gameType);
      if (gameTypeKeys.length > 0 && gameTypeKeys[0]) {
        gameType = gameTypeKeys[0].toLowerCase();
      }
    }

    console.log(`🎮 Game initialized: ${gameAddress}, Type: ${gameType || "unknown"}`);
    this.options.db.trackGame(gameAddress, gameType);
  }

  private validateGameAddressData(
    eventData: { gameAddress: string; playerAddress?: string; ticketIndex?: number },
    eventType: string
  ): { valid: boolean; message?: string } {
    if (!eventData.gameAddress) {
      return {
        valid: false,
        message: `⚠️  Missing game address in ${eventType} event`,
      };
    }
    return { valid: true };
  }

  private validatePlayerEventData(
    action: "joined" | "unjoined",
    eventData: { gameAddress: string; playerAddress?: string; ticketIndex?: number }
  ): { valid: boolean; message?: string } {
    const baseValidation = this.validateGameAddressData(eventData, `player ${action}`);
    if (!baseValidation.valid) {
      return baseValidation;
    }

    if (eventData.ticketIndex === undefined) {
      return {
        valid: false,
        message: `⚠️  Missing ticket index in ${action} event for ${eventData.gameAddress}`,
      };
    }

    if (action === "joined" && !eventData.playerAddress) {
      return {
        valid: false,
        message: `⚠️  Missing player address in join event for ${eventData.gameAddress}`,
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
