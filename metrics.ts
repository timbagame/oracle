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
  private static readonly DEFAULT_MAX_HISTORY = 500;

  private completionRecords: CompletionRecord[] = [];
  private scanCycles: ScanCycleRecord[] = [];
  private cleanupSweeps: CleanupRecord[] = [];
  private readonly maxHistory: number;

  constructor(options: { maxHistory?: number } = {}) {
    const configured = options.maxHistory ?? OracleMetricsRecorder.DEFAULT_MAX_HISTORY;
    this.maxHistory = configured > 0 ? configured : OracleMetricsRecorder.DEFAULT_MAX_HISTORY;
  }

  recordCompletion(record: CompletionRecord): void {
    this.completionRecords.push(record);
    this.trimBuffer(this.completionRecords);
  }

  recordScanCycle(record: ScanCycleRecord): void {
    this.scanCycles.push(record);
    this.trimBuffer(this.scanCycles);
  }

  recordCleanupSweep(record: CleanupRecord): void {
    this.cleanupSweeps.push(record);
    this.trimBuffer(this.cleanupSweeps);
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

  private trimBuffer<T>(buffer: T[]): void {
    const overflow = buffer.length - this.maxHistory;
    if (overflow > 0) {
      buffer.splice(0, overflow);
    }
  }
}

const globalMetrics = new OracleMetricsRecorder();

export function getOracleMetrics(): OracleMetricsRecorder {
  return globalMetrics;
}

export function resetOracleMetrics(): void {
  globalMetrics.reset();
}
