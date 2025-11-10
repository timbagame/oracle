import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { Timba } from "./idl/idlType.ts";
import type { PublicKeyLike } from "./solana-utils.ts";
import { ensurePublicKey, resolveNumericLike } from "./solana-utils.ts";
import { logger } from "./logger.ts";
import {
  analyzeRegistryState,
  summarizeTicketAssignments,
} from "./player-registry-utils.ts";

export interface PlayerRegistrySyncOptions {
  connection: anchor.web3.Connection;
  program: anchor.Program<Timba>;
  batchSize?: number;
  maxBatches?: number;
  eventParserFactory?: (programId: PublicKey, coder: anchor.Coder) => {
    parseLogs: (logs: string[]) => Iterable<unknown>;
  };
  transactionConcurrency?: number;
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
  private readonly createEventParser: (
    programId: PublicKey,
    coder: anchor.Coder,
  ) => { parseLogs: (logs: string[]) => Iterable<unknown> };

  constructor(private readonly options: PlayerRegistrySyncOptions) {
    this.batchSize = Math.max(10, options.batchSize ?? 500);
    this.maxBatches = Math.max(1, options.maxBatches ?? 6);
    const desiredConcurrency = options.transactionConcurrency ?? 4;
    this.transactionConcurrency = Math.min(10, Math.max(1, desiredConcurrency));
    this.createEventParser = options.eventParserFactory
      ?? ((programId, coder) => new anchor.EventParser(programId, coder));
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
    const coder = (program as unknown as { coder?: anchor.Coder }).coder ??
      new anchor.BorshCoder(program.idl);
    const parser = this.createEventParser(program.programId, coder);

    const ticketAssignments = new Map<number, string>();
    let shouldStopProcessing = false;

    type RegistryEvent =
      | { kind: "join"; ticketIndex: number; playerAddress: string }
      | { kind: "unjoin"; ticketIndex: number };

    const isRegistrySatisfied = () => {
      if (expectedTickets === undefined) {
        return false;
      }

      const { stats } = summarizeTicketAssignments(ticketAssignments);
      const analysis = analyzeRegistryState(stats, expectedTickets);
      return !analysis.needsReconciliation;
    };

    const processSignature = async (
      signatureInfo: anchor.web3.ConfirmedSignatureInfo,
    ): Promise<RegistryEvent[]> => {
      if (shouldStopProcessing) {
        return [];
      }

      let transaction: anchor.web3.TransactionResponse | null;
      try {
        transaction = await this.options.connection.getTransaction(signatureInfo.signature, {
          commitment: "confirmed",
        });
      } catch (error) {
        logger.warning(
          `Failed to fetch transaction ${signatureInfo.signature}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }

      const logs = transaction?.meta?.logMessages;
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
          events.push({ kind: "unjoin", ticketIndex });
          continue;
        }

        let playerKey: PublicKey;
        try {
          playerKey = ensurePublicKey(
            (data["player"] ?? data["playerAddress"] ?? data["player_address"] ?? null) as PublicKeyLike,
          );
        } catch (error) {
          logger.warning(`Skipping player event with invalid player key: ${String(error)}`);
          continue;
        }

        events.push({ kind: "join", ticketIndex, playerAddress: playerKey.toBase58() });
      }

      return events;
    };

    const active = new Set<Promise<void>>();
    const pendingResults = new Map<number, RegistryEvent[]>();
    let nextIndexToApply = 0;

    const applyEventsSequentially = (events: RegistryEvent[]) => {
      if (shouldStopProcessing) {
        return;
      }

      for (const event of events) {
        if (event.kind === "unjoin") {
          ticketAssignments.delete(event.ticketIndex);
          continue;
        }

        ticketAssignments.set(event.ticketIndex, event.playerAddress);
      }

      if (isRegistrySatisfied()) {
        shouldStopProcessing = true;
      }
    };

    const tryApplyPending = () => {
      while (!shouldStopProcessing && pendingResults.has(nextIndexToApply)) {
        const events = pendingResults.get(nextIndexToApply) ?? [];
        pendingResults.delete(nextIndexToApply);
        applyEventsSequentially(events);
        nextIndexToApply += 1;
      }

      if (shouldStopProcessing) {
        while (pendingResults.has(nextIndexToApply)) {
          pendingResults.delete(nextIndexToApply);
          nextIndexToApply += 1;
        }
      }
    };

    const enqueue = (
      signatureInfo: anchor.web3.ConfirmedSignatureInfo,
      index: number,
    ) => {
      const task = processSignature(signatureInfo)
        .then((events) => {
          pendingResults.set(index, events);
          tryApplyPending();
        })
        .finally(() => {
          active.delete(task);
        });
      active.add(task);
      return task;
    };

    for (const [index, signatureInfo] of signatures.entries()) {
      if (shouldStopProcessing) {
        break;
      }

      enqueue(signatureInfo, index);

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

    if (!analysis.expectedMatches) {
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
      if (
        (targetSignatures !== undefined && collected.length >= targetSignatures) ||
        (finiteMaxSignatures !== undefined && collected.length >= finiteMaxSignatures)
      ) {
        break;
      }

      const remainingByTarget =
        targetSignatures !== undefined ? Math.max(0, targetSignatures - collected.length) : undefined;
      const remainingByMax =
        finiteMaxSignatures !== undefined ? Math.max(0, finiteMaxSignatures - collected.length) : undefined;

      if (remainingByTarget === 0 || remainingByMax === 0) {
        break;
      }

      let limit = this.batchSize;
      if (remainingByTarget !== undefined) {
        limit = Math.min(limit, Math.max(1, remainingByTarget));
      }

      if (remainingByMax !== undefined) {
        limit = Math.min(limit, Math.max(1, remainingByMax));
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
