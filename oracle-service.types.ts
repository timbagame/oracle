import type * as anchor from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";
import type { TimbaEventMap, TimbaGameAccount } from "./types/timba.ts";
import type { PublicKeyLike } from "./solana-utils.ts";

export interface GameCompletionResult {
  success: boolean;
  notReady?: boolean;
  error?: string;
  txHash?: string;
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
  event: TimbaEventMap[TKey]
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

export interface OracleEventProcessorDependencies {
  program: { addEventListener: (...args: any[]) => Promise<number>; removeEventListener: (id: number) => Promise<void> };
  config: ReadonlyArray<EventHandlerConfig<keyof TimbaEventMap>>;
  listenerState: {
    getListeners: () => number[];
    setListeners: (ids: number[]) => void;
    isListening: () => boolean;
    setListening: (value: boolean) => void;
  };
  createHandlerContext: () => OracleEventHandlerContext;
}

export interface OracleEventProcessorHooks {
  clearTokenProgramCache: () => void;
}

export interface OracleCompletionDependencies {
  db: {
    incrementCompletionAttempts: (gameAddress: string) => void;
    finalizeCompletedGame: (gameAddress: string) => void;
    getGamePlayers: (gameAddress: string) => string[];
    getSecretKey: (gameAddress: string) => { secretKey: string; randomHash: string } | null;
    markGameCompleted: (gameAddress: string) => void;
  };
  metrics: {
    recordCompletion: (record: { gameAddress: string; outcome: "success" | "error" | "not-ready"; error?: string }) => void;
  };
  connection: {
    getAccountInfo: (pubkey: PublicKey) => Promise<{ owner: PublicKey | null } | null>;
    getSlot: () => Promise<number>;
    getBlockTime: (slot: number) => Promise<number | null>;
    getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
    confirmTransaction: (params: {
      signature: string;
      blockhash: string;
      lastValidBlockHeight: number;
    }) => Promise<void>;
  };
  program: {
    account: { game: { fetch: (pubkey: PublicKey) => Promise<TimbaGameAccount> } };
    methods: {
      completeGame: (
        randomHash: number[],
        secret: number[],
        winnerIndex: number,
      ) => {
        accountsPartial: (accounts: Record<string, unknown>) => {
          signers: (signers: anchor.web3.Keypair[]) => { rpc: () => Promise<string> };
        };
      };
    };
    programId: PublicKeyLike;
  };
  adminKeypair: anchor.web3.Keypair;
  readinessCache: Map<string, GameReadinessSnapshot>;
  tokenProgramCache: Map<string, PublicKey>;
}

export interface OracleScanDependencies {
  db: {
    getPendingGames: (maxAttempts: number) => Array<{ game_address: string }>;
    markGameCompleted: (gameAddress: string) => void;
    touchGameCheck: (gameAddress: string) => void;
  };
  metrics: {
    recordScanCycle: (record: {
      durationMs: number;
      completed: number;
      errors: number;
      notReady: number;
      pending: number;
    }) => void;
  };
  completion: {
    resolveContextAndReadiness: (
      gameAddress: string,
      options?: {
        context?: GameOnChainContext | null;
        readiness?: GameReadinessSnapshot;
        requireOnChain?: boolean;
        blockTime?: number;
      },
    ) => Promise<{
      context: GameOnChainContext | null;
      readiness?: GameReadinessSnapshot;
      notReady: boolean;
    }>;
    attemptGameCompletion: (options: AttemptGameCompletionOptions) => Promise<GameCompletionResult | null>;
    consumeReadiness: (gameAddress: string) => GameReadinessSnapshot | undefined;
    getBlockchainTime: () => Promise<number>;
  };
  delay: (ms: number) => Promise<void>;
  interGameDelayMs: number;
}

