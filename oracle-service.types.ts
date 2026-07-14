import type * as anchor from "@anchor-lang/core";
import type { PublicKey } from "@solana/web3.js";
import type { TimbaEventMap, TimbaGameAccount } from "./types/timba.ts";
import type { PublicKeyLike } from "./solana-utils.ts";
import type { OracleDatabase } from "./database.ts";
import type { OracleMetrics } from "./metrics.ts";
import type { Timba } from "./idl/idlType.ts";

/**
 * Core dependencies shared between OracleService and GameCompletionManager
 */
export interface CoreOracleDependencies {
  db: OracleDatabase;
  metrics: OracleMetrics;
  getConnection: () => anchor.web3.Connection;
  getProgram: () => anchor.Program<Timba>;
  adminKeypair: anchor.web3.Keypair;
}

export interface GameCompletionResult {
  success: boolean;
  notReady?: boolean;
  error?: string;
  txHash?: string;
  winnerAddress?: string;
  totalPot?: number;
}

export interface GameSecrets {
  randomHash: string;
  gameAddress: string;
}

export interface GenerateGameSecretsOptions {
  gameType?: string;
}

export interface CompletionStats {
  completed: number;
  errors: number;
  notReady: number;
}

export function createEmptyCompletionStats(): CompletionStats {
  return { completed: 0, errors: 0, notReady: 0 };
}

export interface ScanLoopOptions {
  waitBetweenCyclesMs?: number;
  waitForPendingOnly?: boolean;
  cleanupAfterCycleHours?: number;
  shouldContinue?: (stats: CompletionStats, cycle: number) => boolean;
  signal?: AbortSignal;
  onCycleStart?: (cycle: number) => void;
  onCycleComplete?: (cycle: number, stats: CompletionStats) => void;
}

export interface ScanLoopSummary {
  cycles: number;
  totalCompleted: number;
  totalErrors: number;
  totalNotReady: number;
  lastStats: CompletionStats | null;
}

export interface GameReadinessSnapshot {
  ready: boolean;
  gameAccount: TimbaGameAccount | null;
  evaluatedAt?: number;
}

export type ReadinessResolution =
  | { status: "missing-context" }
  | {
      status: "ready" | "not-ready";
      context: GameOnChainContext;
      readiness: GameReadinessSnapshot;
      prefetchScheduled: boolean;
    };

export interface GameOnChainContext {
  gamePda: PublicKey;
  secretData: { secretKey: string; randomHash: string };
  randomHashBuffer: Buffer;
  readiness?: GameReadinessSnapshot;
}

export interface AttemptGameCompletionOptions {
  gameAddress: string;
  gameKey?: PublicKeyLike;
  context?: GameOnChainContext | null;
  readiness?: GameReadinessSnapshot;
  skipReadinessCheck?: boolean;
  onResult?: (result: GameCompletionResult) => void;
  successLog?: (gameAddress: string) => string;
  failureLog?: (gameAddress: string, error?: string) => string;
}

export type EventHandler<TKey extends keyof TimbaEventMap> = (
  event: TimbaEventMap[TKey],
) => Promise<void> | void;

export interface EventHandlerConfig<TKey extends keyof TimbaEventMap> {
  event: TKey;
  createHandler: (ctx: OracleEventHandlerContext) => EventHandler<TKey>;
}

export interface OracleEventHandlerContext {
  handlePlayerEvent: (
    action: "joined" | "unjoined",
    event: TimbaEventMap["playerJoined"],
  ) => Promise<void>;
  handleGameInitialized: (event: TimbaEventMap["gameInitialized"]) => void;
  handleGameStatusChange: (
    status: "completed" | "closed",
    event: TimbaEventMap["gameCompleted"],
  ) => void;
}

export interface EventData {
  gameAddress: string;
  playerAddress?: string;
  ticketIndex?: number;
}
