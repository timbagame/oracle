import { address, type Address } from "@solana/kit";
import { fetchGame as fetchGameV020 } from "@timbagame/protocol/contracts/v0.2.0/kit";
import { fetchGame as fetchGameV030 } from "@timbagame/protocol/contracts/v0.3.0/kit";
import type { ContractVersion } from "./contract-idl.ts";
import { getContractIdl } from "./contract-idl.ts";
import { parseTransactionEvents } from "./indexer/solana.ts";
import { logger } from "./logger.ts";
import { createRpcSubscriptions, type OracleRpc } from "./solana-kit.ts";
import type { TimbaEventMap, TimbaGameAccount } from "./types/timba.ts";

type EventName = keyof TimbaEventMap;
type EventCallback = (event: TimbaEventMap[EventName]) => void | Promise<void>;

export class TimbaProgramClient {
  readonly idl;
  readonly programId: Address;
  private readonly listeners = new Map<number, { event: EventName; callback: EventCallback }>();
  private nextListenerId = 1;
  private abortController: AbortController | null = null;
  private subscriptionTask: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly rpc: OracleRpc,
    readonly contractVersion: ContractVersion,
    private readonly getRpcEndpoint: () => string,
  ) {
    this.idl = getContractIdl(contractVersion);
    this.programId = address(this.idl.address);
  }

  async fetchGame(gameAddress: Address): Promise<TimbaGameAccount> {
    const account =
      this.contractVersion === "0.2.0"
        ? await fetchGameV020(this.rpc, gameAddress, { commitment: "confirmed" })
        : await fetchGameV030(this.rpc, gameAddress, { commitment: "confirmed" });
    return account.data;
  }

  async addEventListener<TKey extends EventName>(
    event: TKey,
    callback: (event: TimbaEventMap[TKey]) => void | Promise<void>,
  ): Promise<number> {
    const id = this.nextListenerId++;
    this.listeners.set(id, { event, callback: callback as EventCallback });
    try {
      await this.ensureSubscription();
    } catch (error) {
      this.listeners.delete(id);
      if (this.listeners.size === 0 && this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      throw error;
    }
    return id;
  }

  async removeEventListener(id: number): Promise<void> {
    this.listeners.delete(id);
    if (this.listeners.size === 0) await this.stopSubscription();
  }

  async close(): Promise<void> {
    this.listeners.clear();
    await this.stopSubscription();
  }

  private async ensureSubscription(): Promise<void> {
    if (this.subscriptionTask) return;
    const controller = new AbortController();
    const subscriptions = createRpcSubscriptions(this.getRpcEndpoint());
    const notificationsPromise = subscriptions
      .logsNotifications({ mentions: [this.programId] }, { commitment: "confirmed" })
      .subscribe({ abortSignal: controller.signal });
    this.abortController = controller;
    this.subscriptionTask = (async () => {
      const notifications = await notificationsPromise;
      await this.consumeNotifications(notifications, controller.signal);
    })()
      .catch((error) => {
        if (!controller.signal.aborted) {
          logger.warning("Timba program log subscription failed:", error);
        }
      })
      .finally(() => {
        if (this.abortController === controller) this.abortController = null;
        this.subscriptionTask = null;
        if (!controller.signal.aborted && this.listeners.size > 0) this.scheduleReconnect();
      });
    await notificationsPromise;
  }

  private async stopSubscription(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const task = this.subscriptionTask;
    this.abortController?.abort();
    if (task) {
      try {
        await task;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.listeners.size === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.listeners.size === 0) return;
      void this.ensureSubscription().catch((error) => {
        logger.warning("Failed to restore Timba program log subscription:", error);
        this.scheduleReconnect();
      });
    }, 1_000);
  }

  private async consumeNotifications(
    notifications: AsyncIterable<{
      context: { slot: bigint };
      value: { err: unknown | null; logs: readonly string[]; signature: string };
    }>,
    signal: AbortSignal,
  ): Promise<void> {
    for await (const notification of notifications) {
      if (signal.aborted || notification.value.err) continue;
      const slot = Number(notification.context.slot);
      if (!Number.isSafeInteger(slot)) continue;
      const parsed = parseTransactionEvents(
        notification.value.signature,
        slot,
        notification.value.logs,
        this.programId,
      );
      const dispatches = [
        ...parsed.initialized.map((value) => ({
          event: "gameInitialized" as const,
          payload: value,
        })),
        ...parsed.completed.map((value) => ({ event: "gameCompleted" as const, payload: value })),
        ...parsed.closed.map((value) => ({
          event: value.operator ? ("operatorGameClosed" as const) : ("gameClosed" as const),
          payload: value,
        })),
        ...parsed.membership.map((value) => ({
          event: value.kind === "joined" ? ("playerJoined" as const) : ("playerUnjoined" as const),
          payload: value,
        })),
      ] as unknown as Array<{ event: EventName; payload: TimbaEventMap[EventName] }>;

      for (const { event, payload } of dispatches) {
        const callbacks = [...this.listeners.values()].filter(
          (listener) => listener.event === event,
        );
        await Promise.all(callbacks.map(({ callback }) => callback(payload)));
      }
    }
  }
}
