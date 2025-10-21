import type { OracleApi } from "../../index.ts";

type OracleStats = ReturnType<OracleApi["getStats"]>;

type CompletionStats = Awaited<ReturnType<OracleApi["scanAndCompleteActiveGames"]>>;

type CleanupStats = ReturnType<OracleApi["cleanupOldRecords"]>;

export interface FakeOracleOptions {
  stats?: Partial<OracleStats>;
  generateGameSecrets?: OracleApi["generateGameSecrets"];
  getStats?: OracleApi["getStats"];
  scanAndCompleteActiveGames?: OracleApi["scanAndCompleteActiveGames"];
  startEventListening?: OracleApi["startEventListening"];
  stopEventListening?: OracleApi["stopEventListening"];
  cleanupOldRecords?: OracleApi["cleanupOldRecords"];
}

const DEFAULT_COMPLETION_STATS: CompletionStats = {
  completed: 0,
  errors: 0,
  notReady: 0,
};

const DEFAULT_CLEANUP_STATS: CleanupStats = {
  deletedSecrets: 0,
  deletedGames: 0,
};

export function createBasicStats(overrides: Partial<OracleStats> = {}): OracleStats {
  return {
    totalSecrets: 0,
    usedSecrets: 0,
    pendingGames: 0,
    completedGames: 0,
    cancelledGames: 0,
    eventListening: false,
    activeListeners: 0,
    ...overrides,
  };
}

export function createBasicOracle(options: FakeOracleOptions = {}): OracleApi {
  const {
    stats,
    generateGameSecrets,
    getStats,
    scanAndCompleteActiveGames,
    startEventListening,
    stopEventListening,
    cleanupOldRecords,
  } = options;

  return {
    generateGameSecrets:
      generateGameSecrets ?? (() => ({ randomHash: "test-hash", gameAddress: "game-123" })),
    getStats:
      getStats ?? (() => createBasicStats(stats)),
    scanAndCompleteActiveGames:
      scanAndCompleteActiveGames ?? (async () => ({ ...DEFAULT_COMPLETION_STATS })),
    startEventListening: startEventListening ?? (async () => {}),
    stopEventListening: stopEventListening ?? (async () => {}),
    cleanupOldRecords: cleanupOldRecords ?? (() => ({ ...DEFAULT_CLEANUP_STATS })),
  };
}
