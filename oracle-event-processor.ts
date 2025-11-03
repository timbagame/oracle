import type * as anchor from "@coral-xyz/anchor";
import type { Timba } from "./idl/idlType.ts";
import type { OracleDatabase } from "./database.ts";
import type { TimbaEventMap, TimbaEvent, TimbaPlayerEvent, TimbaGameStatusEvent, TimbaGameInitializedEvent, NumericLike } from "./types/timba.ts";
import type { PublicKeyLike } from "./solana-utils.ts";
import type { EventHandlerConfig } from "./oracle-service.types.ts";
import { toBase58 } from "./solana-utils.ts";

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
    const { gameAddress, playerAddress, ticketIndex } = this.extractEventData(event);

    try {
      if (!gameAddress) {
        console.warn(`⚠️  Missing game address in ${action} event`);
        return;
      }

      if (ticketIndex === undefined) {
        console.warn(`⚠️  Missing ticket index in ${action} event for ${gameAddress}`);
        return;
      }

      switch (action) {
        case "joined":
          if (!playerAddress) {
            console.warn(`⚠️  Missing player address in join event for ${gameAddress}`);
            return;
          }
          this.options.db.addPlayerToGame(gameAddress, playerAddress, ticketIndex);
          break;
        case "unjoined":
          this.options.db.removePlayerFromGame(gameAddress, ticketIndex);
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
    const { gameAddress } = this.extractEventData(event);

    try {
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
    const { gameAddress } = this.extractEventData(event);

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

  public extractEventData(event: TimbaEvent): { gameAddress: string; playerAddress?: string; ticketIndex?: number } {
    const gameKey = (event.gameKey ?? event.gameAddress ?? event.game) as PublicKeyLike | undefined;
    const playerKey = (event.player ?? event.playerAddress) as PublicKeyLike | undefined;

    const resolveIndex = (value: NumericLike | undefined): number | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value === "number") return value;
      if (typeof value === "bigint") return Number(value);

      const withToNumber = value as { toNumber?: () => number };
      if (typeof withToNumber.toNumber === "function") {
        return withToNumber.toNumber();
      }

      const withValueOf = value as { valueOf?: () => number | bigint };
      if (typeof withValueOf.valueOf === "function") {
        const raw = withValueOf.valueOf();
        if (typeof raw === "number") return raw;
        if (typeof raw === "bigint") return Number(raw);
      }

      return undefined;
    };

    return {
      gameAddress: gameKey ? toBase58(gameKey) ?? "" : "",
      playerAddress: playerKey ? toBase58(playerKey) : undefined,
      ticketIndex: resolveIndex(event.ticketIndex ?? event.ticket_index),
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

