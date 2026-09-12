import { address } from "@solana/kit";

// Known token addresses
export const TIMBA_MINT = address("F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump");
export const SOL_MINT = address("So11111111111111111111111111111111111111112");
export const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDT_MINT = address("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
export const MAGAIBA_MINT = address("A6rSPi9JmJgVkW6BatsA6MjFYLseizPM2Fnt92coFjf4");

// Token decimals
export const TOKEN_DECIMALS: Record<string, number> = {
  [TIMBA_MINT]: 6,
  [SOL_MINT]: 9,
  [USDC_MINT]: 6,
  [USDT_MINT]: 6,
  [MAGAIBA_MINT]: 6,
};

// Token symbols
export const TOKEN_SYMBOLS: Record<string, string> = {
  [TIMBA_MINT]: "TIMBA",
  [SOL_MINT]: "SOL",
  [USDC_MINT]: "USDC",
  [USDT_MINT]: "USDT",
  [MAGAIBA_MINT]: "MAGAIBA",
};

export function getTokenSymbol(mint: string): string {
  return TOKEN_SYMBOLS[mint] ?? `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}
