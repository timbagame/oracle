import type { OracleApi } from "../../index.ts";
import { createEmptyStats } from "../../database.ts";
import { createEmptyCompletionStats } from "../../oracle-service.ts";

type OracleStats = ReturnType<OracleApi["getStats"]>;

type CleanupStats = ReturnType<OracleApi["cleanupOldRecords"]>;

export interface FakeOracleOptions {
  stats?: Partial<OracleStats>;
  generateGameSecrets?: OracleApi["generateGameSecrets"];
  getStats?: OracleApi["getStats"];
  scanAndCompleteActiveGames?: OracleApi["scanAndCompleteActiveGames"];
  startEventListening?: OracleApi["startEventListening"];
  stopEventListening?: OracleApi["stopEventListening"];
  close?: OracleApi["close"];
  cleanupOldRecords?: OracleApi["cleanupOldRecords"];
  requeueGame?: OracleApi["requeueGame"];
  setAutoCompleteDisabled?: OracleApi["setAutoCompleteDisabled"];
}

const DEFAULT_CLEANUP_STATS: CleanupStats = {
  deletedSecrets: 0,
  deletedGames: 0,
  deletedPlayers: 0,
};

export function createBasicStats(overrides: Partial<OracleStats> = {}): OracleStats {
  return {
    ...createEmptyStats(),
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
    close,
    cleanupOldRecords,
    requeueGame,
    setAutoCompleteDisabled,
  } = options;

  return {
    generateGameSecrets:
      generateGameSecrets ?? ((
        _options?: Parameters<OracleApi["generateGameSecrets"]>[0]
      ) => ({ randomHash: "test-hash", gameAddress: "game-123" })),
    getStats:
      getStats ?? (() => createBasicStats(stats)),
    scanAndCompleteActiveGames:
      scanAndCompleteActiveGames ?? (async () => ({ ...createEmptyCompletionStats() })),
    startEventListening: startEventListening ?? (async () => {}),
    stopEventListening: stopEventListening ?? (async () => {}),
    close: close ?? (async () => {}),
    cleanupOldRecords: cleanupOldRecords ?? (() => ({ ...DEFAULT_CLEANUP_STATS })),
    requeueGame: requeueGame ?? (() => ({ success: true })),
    setAutoCompleteDisabled:
      setAutoCompleteDisabled ?? (() => ({ success: true, autoCompleteDisabled: false })),
  };
}
