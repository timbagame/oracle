/**
 * Shared utility for formatting completion statistics
 */

export interface CompletionStats {
  completed: number;
  errors: number;
  notReady: number;
}

/**
 * Formats completion statistics into a human-readable string
 * @param stats The completion statistics to format
 * @returns Formatted string or empty string if no stats to report
 */
export function formatCompletionStats(stats: CompletionStats): string {
  if (stats.completed === 0 && stats.errors === 0 && stats.notReady === 0) {
    return "";
  }

  const parts: string[] = [];

  if (stats.completed > 0) {
    parts.push(`${stats.completed} completed`);
  }

  if (stats.errors > 0) {
    parts.push(`${stats.errors} errors`);
  }

  if (stats.notReady > 0) {
    parts.push(`${stats.notReady} not ready`);
  }

  return parts.join(", ");
}
