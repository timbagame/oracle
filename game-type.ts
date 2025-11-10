export const MAX_GAME_TYPE_LENGTH = 128;

export interface NormalizeGameTypeOptions {
  maxLength?: number;
  allowTruncate?: boolean;
}

export interface NormalizeGameTypeResult {
  value?: string;
  truncated?: boolean;
  error?: string;
  originalLength?: number;
}

export function normalizeGameType(
  rawValue: unknown,
  options: NormalizeGameTypeOptions = {},
): NormalizeGameTypeResult {
  if (typeof rawValue !== "string") {
    return { value: undefined };
  }

  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return { value: undefined };
  }

  const normalized = trimmed.toLowerCase();
  const maxLength = options.maxLength ?? MAX_GAME_TYPE_LENGTH;
  const originalLength = normalized.length;

  if (originalLength <= maxLength) {
    return { value: normalized, originalLength };
  }

  if (options.allowTruncate) {
    return {
      value: normalized.slice(0, maxLength),
      truncated: true,
      originalLength,
    };
  }

  return {
    error: `gameType must be at most ${maxLength} characters`,
    originalLength,
  };
}
