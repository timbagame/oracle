import type { Signature } from "@solana/kit";
import { parseTransactionEvents } from "./indexer/solana.ts";
import { logger } from "./logger.ts";
import { analyzeRegistryState, summarizeTicketAssignments } from "./player-registry-utils.ts";
import { sendRpcRequest, type OracleRpc } from "./solana-kit.ts";
import { ensureAddress, type PublicKeyLike } from "./solana-utils.ts";

export interface PlayerRegistrySyncOptions {
  connection: OracleRpc;
  programId: PublicKeyLike;
  batchSize?: number;
  maxBatches?: number;
  transactionConcurrency?: number;
  parseEvents?: (
    logs: readonly string[] | null | undefined,
    transactionSignature: string,
    slot: number,
  ) => RegistryEvent[];
}

export interface FetchRegistryParams {
  gamePda: PublicKeyLike;
  expectedTickets?: number;
  maxSignatures?: number;
}

export type RegistryEvent =
  | { kind: "join"; ticketIndex: number; playerAddress: string }
  | { kind: "unjoin"; ticketIndex: number; movedParticipant?: string };

type SignatureInfo = Readonly<{ signature: Signature; slot: bigint }>;

export class PlayerRegistrySync {
  private readonly batchSize: number;
  private readonly maxBatches: number;
  private readonly transactionConcurrency: number;

  constructor(private readonly options: PlayerRegistrySyncOptions) {
    this.batchSize = Math.max(10, options.batchSize ?? 500);
    this.maxBatches = Math.max(1, options.maxBatches ?? 6);
    this.transactionConcurrency = Math.min(10, Math.max(1, options.transactionConcurrency ?? 4));
  }

  private async runWithConcurrency<TItem, TResult>(
    items: readonly TItem[],
    fn: (item: TItem) => Promise<TResult>,
  ): Promise<TResult[]> {
    const results = new Array<TResult>(items.length);
    let index = 0;
    const worker = async () => {
      while (index < items.length) {
        const current = index++;
        results[current] = await fn(items[current]!);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.transactionConcurrency, items.length) }, worker),
    );
    return results;
  }

  public async fetchPlayersFromChain(params: FetchRegistryParams): Promise<string[] | null> {
    const signatures = await this.collectSignatures(params.gamePda, {
      maxSignatures: params.maxSignatures,
    });
    if (signatures.length === 0) return null;

    const transactionEvents = await this.runWithConcurrency(signatures, async (item) => {
      try {
        const transaction = await sendRpcRequest(
          this.options.connection.getTransaction(item.signature, {
            commitment: "confirmed",
            encoding: "json",
            maxSupportedTransactionVersion: 0,
          }),
        );
        return this.parseEvents(transaction?.meta?.logMessages, item.signature, Number(item.slot));
      } catch (error) {
        logger.warning(
          `Failed to fetch transaction ${item.signature}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    });

    const ticketAssignments = new Map<number, string>();
    for (const events of transactionEvents) {
      for (const event of events) {
        if (event.kind === "unjoin") {
          ticketAssignments.delete(event.ticketIndex);
          if (event.movedParticipant) {
            const movedIndex = [...ticketAssignments.entries()].find(
              ([, participant]) => participant === event.movedParticipant,
            )?.[0];
            if (movedIndex !== undefined) ticketAssignments.delete(movedIndex);
            ticketAssignments.set(event.ticketIndex, event.movedParticipant);
          }
        } else {
          ticketAssignments.set(event.ticketIndex, event.playerAddress);
        }
      }
    }

    if (ticketAssignments.size === 0) return null;
    const { orderedEntries, stats } = summarizeTicketAssignments(ticketAssignments);
    const analysis = analyzeRegistryState(stats, params.expectedTickets);
    if (!analysis.contiguous) {
      logger.warning(
        `Recovered player registry for ${params.gamePda} contains gaps (indexes: ${orderedEntries.map((entry) => entry[0]).join(",")})`,
      );
      return null;
    }
    if (!analysis.expectedMatches) return null;
    return orderedEntries.map(([, playerAddress]) => playerAddress);
  }

  private parseEvents(
    logs: readonly string[] | null | undefined,
    transactionSignature: string,
    slot: number,
  ): RegistryEvent[] {
    if (this.options.parseEvents) {
      return this.options.parseEvents(logs, transactionSignature, slot);
    }
    if (!logs?.length) return [];
    const { membership } = parseTransactionEvents(
      transactionSignature,
      slot,
      logs,
      ensureAddress(this.options.programId),
    );
    return membership.map((event) =>
      event.kind === "joined"
        ? { kind: "join", ticketIndex: event.ticketIndex, playerAddress: event.player }
        : {
            kind: "unjoin",
            ticketIndex: event.ticketIndex,
            ...(event.movedParticipant ? { movedParticipant: event.movedParticipant } : {}),
          },
    );
  }

  private async collectSignatures(
    gamePda: PublicKeyLike,
    options: { maxSignatures?: number } = {},
  ): Promise<SignatureInfo[]> {
    const finiteMax =
      options.maxSignatures !== undefined && Number.isFinite(options.maxSignatures)
        ? Math.max(0, Math.floor(options.maxSignatures))
        : undefined;
    const collected: SignatureInfo[] = [];
    let before: Signature | undefined;

    for (let batch = 0; batch < this.maxBatches; batch += 1) {
      if (finiteMax !== undefined && collected.length >= finiteMax) break;
      const remainingMax = finiteMax === undefined ? this.batchSize : finiteMax - collected.length;
      // Current ticket count does not bound the history: joins, unjoins, and
      // unrelated transactions can precede the surviving participants.
      const limit = Math.max(1, Math.min(this.batchSize, remainingMax));
      const page = await sendRpcRequest(
        this.options.connection.getSignaturesForAddress(ensureAddress(gamePda), {
          ...(before ? { before } : {}),
          commitment: "confirmed",
          limit,
        }),
      );
      if (page.length === 0) break;
      collected.push(...page.map(({ signature: value, slot }) => ({ signature: value, slot })));
      before = page.at(-1)!.signature as Signature;
      if (page.length < limit) break;
    }

    return collected.reverse();
  }
}
