import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { getAddress, type Address } from "viem";

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => getAddress(value));
export const uintSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(78)
  .refine((value) => BigInt(value) < 2n ** 256n);
export const configSchema = z.strictObject({
  chainId: z.number().int().positive().safe(),
  address: addressSchema,
  version: z.literal("0.1.0"),
  rpcUrls: z.array(z.url()).min(1),
  startBlock: uintSchema.refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)),
  confirmations: z.number().int().min(1).max(256).default(2),
  pollMs: z.number().int().min(250).max(60_000).default(2_000),
  database: z.string().min(1),
  operatorKeyFile: z.string().min(1),
  apiTokenFile: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(3002),
  // Token policy is deliberately off chain. Never authorize arbitrary contracts.
  tokens: z
    .array(
      z.strictObject({
        address: addressSchema,
        symbol: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/),
        decimals: z.number().int().min(0).max(36),
        minimumAmount: uintSchema.refine((value) => BigInt(value) > 0n),
      }),
    )
    .min(1),
});
export type EvmConfig = z.output<typeof configSchema>;
export function loadConfig(path: string): EvmConfig {
  const result = configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (new Set(result.tokens.map((token) => token.address)).size !== result.tokens.length)
    throw new Error("Duplicate EVM token policy");
  return result;
}
export function loadSecret(path: string): string {
  const info = statSync(path);
  if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0)
    throw new Error("EVM secret files must be private regular files (mode 600 or 400)");
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error("Empty EVM secret file");
  return value;
}
export function tokenPolicy(config: EvmConfig, address: Address) {
  const token = config.tokens.find((token) => token.address === getAddress(address));
  if (!token) throw new Error("Unsupported EVM token");
  return token;
}
