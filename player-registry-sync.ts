import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import type { Timba } from "./types/contract.ts";
import type { PublicKeyLike } from "./solana-utils.ts";
import { ensurePublicKey, resolveNumericLike, toBase58 } from "./solana-utils.ts";
import { logger } from "./logger.ts";
import { analyzeRegistryState, summarizeTicketAssignments } from "./player-registry-utils.ts";

export interface PlayerRegistrySyncOptions {
  connection: anchor.web3.Connection;
  program: anchor.Program<Timba>;
  batchSize?: number;
  maxBatches?: number;
  eventParserFactory?: (
    programId: PublicKey,
    coder: anchor.Coder,
  ) => {
    parseLogs: (logs: string[]) => Iterable<unknown>;
  };
  transactionConcurrency?: number;
  transactionBatchSize?: number;
  disableBatchTransactions?: boolean;
}

export interface FetchRegistryParams {
  gamePda: PublicKey;
  expectedTickets?: number;
  maxSignatures?: number;
}

export class PlayerRegistrySync {
  private readonly batchSize: number;
  private readonly maxBatches: number;
  private readonly transactionConcurrency: number;
  private readonly transactionBatchSize: number;
  private disableBatchTransactions: boolean;
  private readonly createEventParser: (
    programId: PublicKey,
    coder: anchor.Coder,
  ) => { parseLogs: (logs: string[]) => Iterable<unknown> };

  constructor(private readonly options: PlayerRegistrySyncOptions) {
    this.batchSize = Math.max(10, options.batchSize ?? 500);
    this.maxBatches = Math.max(1, options.maxBatches ?? 6);
    const desiredConcurrency = options.transactionConcurrency ?? 4;
    this.transactionConcurrency = Math.min(10, Math.max(1, desiredConcurrency));
    const derivedBatchSize = Math.max(1, Math.floor(this.batchSize / 5));
    this.transactionBatchSize = Math.min(
      100,
      Math.max(5, options.transactionBatchSize ?? derivedBatchSize ?? 25),
    );
    this.disableBatchTransactions = options.disableBatchTransactions ?? false;
    this.createEventParser =
      options.eventParserFactory ??
      ((programId, coder) => new anchor.EventParser(programId, coder));
  }

  private isPaidPlanBatchError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /batch requests are only available for paid plans/i.test(message);
  }

  private async runWithConcurrency<TItem>(
    items: readonly TItem[],
    fn: (item: TItem) => Promise<void>,
  ): Promise<void> {
    const concurrency = Math.max(1, this.transactionConcurrency);
    const active = new Set<Promise<void>>();

    for (const item of items) {
      const task = fn(item).finally(() => {
        active.delete(task);
      });
      active.add(task);
      if (active.size >= concurrency) {
        await Promise.race(active);
      }
    }

    if (active.size > 0) {
      await Promise.all(active);
    }
  }

  public async fetchPlayersFromChain(params: FetchRegistryParams): Promise<string[] | null> {
    const { gamePda, expectedTickets } = params;
    const signatures = await this.collectSignatures(gamePda, {
      maxSignatures: params.maxSignatures,
      expectedTickets: params.expectedTickets,
    });

    if (signatures.length === 0) {
      return null;
    }

    const program = this.options.program;
    const coder =
      (program as unknown as { coder?: anchor.Coder }).coder ?? new anchor.BorshCoder(program.idl);
    const parser = this.createEventParser(program.programId, coder);

    const ticketAssignments = new Map<number, string>();
    let sawUnjoinEvent = false;

    type RegistryEvent =
      | { kind: "join"; ticketIndex: number; playerAddress: string }
      | { kind: "unjoin"; ticketIndex: number; movedParticipant?: string };

    const parseEventsFromLogs = (logs: string[] | null | undefined): RegistryEvent[] => {
      if (!logs?.length) {
        return [];
      }

      const events: RegistryEvent[] = [];
      for (const event of parser.parseLogs(logs)) {
        if (!event || typeof event !== "object") {
          continue;
        }

        const { name, data } = event as { name?: string; data?: Record<string, unknown> };
        if (!name || !data) {
          continue;
        }

        if (name !== "playerJoined" && name !== "playerUnjoined") {
          continue;
        }

        let eventGameKey: PublicKey;
        try {
          eventGameKey = ensurePublicKey(
            (data["gameKey"] ?? data["game_key"] ?? data["game"] ?? null) as PublicKeyLike,
          );
        } catch (error) {
          logger.warning(`Skipping player event with invalid game key: ${String(error)}`);
          continue;
        }
        if (!eventGameKey.equals(gamePda)) {
          continue;
        }

        const ticketIndex = resolveNumericLike(data["ticketIndex"] ?? data["ticket_index"]);
        if (ticketIndex === undefined || ticketIndex < 0) {
          continue;
        }

        if (name === "playerUnjoined") {
          const movedValue = data["movedParticipant"] ?? data["moved_participant"];
          const movedParticipant = movedValue
            ? (toBase58(movedValue as PublicKeyLike) ?? undefined)
            : undefined;
          events.push({ kind: "unjoin", ticketIndex, movedParticipant });
          continue;
        }

        let playerKey: PublicKey;
        try {
          playerKey = ensurePublicKey(
            (data["player"] ??
              data["playerAddress"] ??
              data["player_address"] ??
              null) as PublicKeyLike,
          );
        } catch (error) {
          logger.warning(`Skipping player event with invalid player key: ${String(error)}`);
          continue;
        }

        events.push({ kind: "join", ticketIndex, playerAddress: playerKey.toBase58() });
      }

      return events;
    };

    const fetchSingleSignature = async (
      signatureInfo: anchor.web3.ConfirmedSignatureInfo,
    ): Promise<RegistryEvent[]> => {
      try {
        const transaction = await this.options.connection.getTransaction(signatureInfo.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        return parseEventsFromLogs(transaction?.meta?.logMessages);
      } catch (error) {
        logger.warning(
          `Failed to fetch transaction ${signatureInfo.signature}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    };

    const active = new Set<Promise<void>>();
    const pendingResults = new Map<number, RegistryEvent[]>();
    let nextIndexToApply = 0;

    const applyEventsSequentially = (events: RegistryEvent[]) => {
      for (const event of events) {
        if (event.kind === "unjoin") {
          ticketAssignments.delete(event.ticketIndex);
          if (event.movedParticipant) {
            const movedTicketIndex = [...ticketAssignments.entries()].find(
              ([, participant]) => participant === event.movedParticipant,
            )?.[0];
            if (movedTicketIndex !== undefined) ticketAssignments.delete(movedTicketIndex);
            ticketAssignments.set(event.ticketIndex, event.movedParticipant);
          }
          sawUnjoinEvent = true;
          continue;
        }

        ticketAssignments.set(event.ticketIndex, event.playerAddress);
      }
    };

    const tryApplyPending = () => {
      while (pendingResults.has(nextIndexToApply)) {
        const events = pendingResults.get(nextIndexToApply) ?? [];
        pendingResults.delete(nextIndexToApply);
        applyEventsSequentially(events);
        nextIndexToApply += 1;
      }
    };

    const recordEvents = (index: number, events: RegistryEvent[]) => {
      pendingResults.set(index, events);
      tryApplyPending();
    };

    const processChunk = async (
      chunkInfos: anchor.web3.ConfirmedSignatureInfo[],
      startIndex: number,
    ): Promise<void> => {
      const signaturesForChunk = chunkInfos.map((info) => info.signature);
      let transactions:
        | (anchor.web3.TransactionResponse | anchor.web3.VersionedTransactionResponse | null)[]
        | null = null;

      try {
        if (!this.disableBatchTransactions) {
          transactions = await this.options.connection.getTransactions(signaturesForChunk, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
        }
      } catch (error) {
        if (this.isPaidPlanBatchError(error)) {
          this.disableBatchTransactions = true;
        }
        logger.warning(
          `Failed to batch fetch transactions (${signaturesForChunk.length}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!transactions || transactions.length === 0) {
        await this.runWithConcurrency(
          chunkInfos.map((info, offset) => ({ info, offset })),
          async ({ info, offset }) => {
            const events = await fetchSingleSignature(info);
            recordEvents(startIndex + offset, events);
          },
        );
        return;
      }

      const perSignatureFetches: Promise<void>[] = [];
      for (let offset = 0; offset < chunkInfos.length; offset += 1) {
        const response = transactions[offset] ?? null;
        if (response) {
          const events = parseEventsFromLogs(response.meta?.logMessages);
          recordEvents(startIndex + offset, events);
          continue;
        }

        const info = chunkInfos[offset];
        if (!info) {
          continue;
        }
        perSignatureFetches.push(
          (async () => {
            const events = await fetchSingleSignature(info);
            recordEvents(startIndex + offset, events);
          })(),
        );
      }

      if (perSignatureFetches.length > 0) {
        await Promise.all(perSignatureFetches);
      }
    };

    const enqueueChunk = (chunkInfos: anchor.web3.ConfirmedSignatureInfo[], startIndex: number) => {
      const task = processChunk(chunkInfos, startIndex).finally(() => {
        active.delete(task);
      });
      active.add(task);
      return task;
    };

    for (let index = 0; index < signatures.length; index += this.transactionBatchSize) {
      const chunkInfos = signatures.slice(index, index + this.transactionBatchSize);
      enqueueChunk(chunkInfos, index);

      if (active.size >= this.transactionConcurrency) {
        await Promise.race(active);
      }
    }

    if (active.size > 0) {
      await Promise.all(active);
    }

    tryApplyPending();

    if (ticketAssignments.size === 0) {
      return null;
    }

    const { orderedEntries, stats } = summarizeTicketAssignments(ticketAssignments);
    const analysis = analyzeRegistryState(stats, expectedTickets);

    if (!analysis.contiguous) {
      logger.warning(
        `Recovered player registry for ${gamePda.toBase58()} contains gaps (indexes: ${orderedEntries.map((entry) => entry[0]).join(",")})`,
      );
      return null;
    }

    if (!analysis.expectedMatches && !sawUnjoinEvent) {
      return null;
    }

    return orderedEntries.map(([, address]) => address);
  }

  private async collectSignatures(
    gamePda: PublicKey,
    options: { maxSignatures?: number; expectedTickets?: number } = {},
  ) {
    const finiteMaxSignatures =
      options.maxSignatures !== undefined && Number.isFinite(options.maxSignatures)
        ? Math.max(0, Math.floor(options.maxSignatures))
        : undefined;
    const targetSignatures =
      options.expectedTickets !== undefined &&
      Number.isFinite(options.expectedTickets) &&
      options.expectedTickets > 0
        ? Math.max(0, Math.floor(options.expectedTickets))
        : undefined;
    const collected: anchor.web3.ConfirmedSignatureInfo[] = [];
    let before: string | undefined;

    for (let batch = 0; batch < this.maxBatches; batch++) {
      if (finiteMaxSignatures !== undefined && collected.length >= finiteMaxSignatures) {
        break;
      }

      const remainingByMax =
        finiteMaxSignatures !== undefined
          ? Math.max(0, finiteMaxSignatures - collected.length)
          : undefined;
      const remainingByTarget =
        targetSignatures !== undefined
          ? Math.max(0, targetSignatures - collected.length)
          : undefined;

      let limit = this.batchSize;
      if (remainingByMax !== undefined) {
        limit = Math.min(limit, Math.max(1, remainingByMax));
      }
      if (remainingByTarget !== undefined && remainingByTarget > 0) {
        limit = Math.min(limit, Math.max(1, remainingByTarget));
      }

      const page = await this.options.connection.getSignaturesForAddress(gamePda, {
        before,
        limit,
      });

      if (page.length === 0) {
        break;
      }

      collected.push(...page);
      before = page[page.length - 1]?.signature;

      if (page.length < limit) {
        break;
      }
    }

    return collected.reverse();
  }
}
