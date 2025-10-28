export const DEFAULT_DELAY_MS = 1000;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
