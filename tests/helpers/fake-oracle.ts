import type { OracleApi } from "../../index.ts";
import { createEmptyStats } from "../../database.ts";
import { createEmptyCompletionStats } from "../../oracle-service.ts";

const TEST_ADDRESS = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";
const TEST_OPERATOR = "11111111111111111111111111111111";

type OracleStats = ReturnType<OracleApi["getStats"]>;

type CleanupStats = ReturnType<OracleApi["cleanupOldRecords"]>;

export interface FakeOracleOptions {
  stats?: Partial<OracleStats>;
  generateGameSecrets?: OracleApi["generateGameSecrets"];
  signGameTransaction?: NonNullable<OracleApi["signGameTransaction"]>;
  getStats?: OracleApi["getStats"];
  scanAndCompleteActiveGames?: OracleApi["scanAndCompleteActiveGames"];
  startEventListening?: OracleApi["startEventListening"];
  stopEventListening?: OracleApi["stopEventListening"];
  close?: OracleApi["close"];
  cleanupOldRecords?: OracleApi["cleanupOldRecords"];
  requeueGame?: OracleApi["requeueGame"];
  completeGameNow?: OracleApi["completeGameNow"];
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
    signGameTransaction,
    getStats,
    scanAndCompleteActiveGames,
    startEventListening,
    stopEventListening,
    close,
    cleanupOldRecords,
    requeueGame,
    completeGameNow,
    setAutoCompleteDisabled,
  } = options;

  return {
    generateGameSecrets:
      generateGameSecrets ??
      ((_options?: Parameters<OracleApi["generateGameSecrets"]>[0]) => ({
        randomHash: "ab".repeat(32),
        gameAddress: TEST_ADDRESS,
        oracleOperator: TEST_OPERATOR,
      })),
    signGameTransaction,
    getStats: getStats ?? (() => createBasicStats(stats)),
    scanAndCompleteActiveGames:
      scanAndCompleteActiveGames ?? (async () => ({ ...createEmptyCompletionStats() })),
    startEventListening: startEventListening ?? (async () => {}),
    stopEventListening: stopEventListening ?? (async () => {}),
    close: close ?? (async () => {}),
    cleanupOldRecords: cleanupOldRecords ?? (() => ({ ...DEFAULT_CLEANUP_STATS })),
    requeueGame: requeueGame ?? (() => ({ success: true })),
    completeGameNow: completeGameNow ?? (async () => ({ success: false, notReady: true })),
    setAutoCompleteDisabled:
      setAutoCompleteDisabled ?? (() => ({ success: true, autoCompleteDisabled: false })),
  };
}
