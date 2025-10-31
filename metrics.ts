export type CompletionOutcome = "success" | "not-ready" | "error";

export interface CompletionRecord {
  readonly gameAddress: string;
  readonly outcome: CompletionOutcome;
  readonly error?: string;
}

export interface ScanCycleRecord {
  readonly durationMs: number;
  readonly completed: number;
  readonly errors: number;
  readonly notReady: number;
  readonly pending: number;
}

export interface CleanupRecord {
  readonly hoursOld: number;
  readonly deletedSecrets: number;
  readonly deletedGames: number;
  readonly deletedPlayers: number;
}

export interface OracleMetrics {
  recordCompletion(record: CompletionRecord): void;
  recordScanCycle(record: ScanCycleRecord): void;
  recordCleanupSweep(record: CleanupRecord): void;
}

export class OracleMetricsRecorder implements OracleMetrics {
  private completionRecords: CompletionRecord[] = [];
  private scanCycles: ScanCycleRecord[] = [];
  private cleanupSweeps: CleanupRecord[] = [];

  recordCompletion(record: CompletionRecord): void {
    this.completionRecords.push(record);
  }

  recordScanCycle(record: ScanCycleRecord): void {
    this.scanCycles.push(record);
  }

  recordCleanupSweep(record: CleanupRecord): void {
    this.cleanupSweeps.push(record);
  }

  reset(): void {
    this.completionRecords = [];
    this.scanCycles = [];
    this.cleanupSweeps = [];
  }

  getCompletionRecords(): CompletionRecord[] {
    return [...this.completionRecords];
  }

  getScanCycles(): ScanCycleRecord[] {
    return [...this.scanCycles];
  }

  getCleanupSweeps(): CleanupRecord[] {
    return [...this.cleanupSweeps];
  }
}

const globalMetrics = new OracleMetricsRecorder();

export function getOracleMetrics(): OracleMetricsRecorder {
  return globalMetrics;
}

export function resetOracleMetrics(): void {
  globalMetrics.reset();
}
