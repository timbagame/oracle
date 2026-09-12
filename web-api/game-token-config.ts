import { evaluateTokenPolicy } from "@timbagame/protocol/oracle";
import { getMintDecoder, getMintSize } from "@solana-program/token";
import {
  getGameTokenDecoder,
  identifyTimbaAccount,
  TimbaAccount,
} from "@timbagame/protocol/contracts/v0.2.0/kit";
import { fetchEncodedAccount, fetchEncodedAccounts, type Address } from "@solana/kit";
import type { TokenPolicy } from "@timbagame/protocol/oracle";
import type { TimbaRpc } from "./connection.ts";
import { TOKEN_DECIMALS, TOKEN_SYMBOLS, getTokenSymbol } from "./token-utils.ts";
import { PROGRAM_ID, getGameTokenPDA } from "./program.ts";
import { TOKEN_PROGRAM_ID } from "./token-program.ts";
import { CreateGameValidationError } from "./create-game-request.ts";
import { formatTokenAmount } from "./token-amount.ts";

interface RawAccount {
  data: Uint8Array;
  programAddress: Address;
}

export interface GameTokenMetadata {
  decimals: number;
  symbol: string;
}

export interface GameTokenConfig {
  mint: string;
  symbol: string;
  decimals: number;
  minimumAmount: string;
  minimumAmountRaw: string;
  enabled: boolean;
  priceUsd?: number | null;
}

export function decodeGameTokenMetadata(
  mint: Address,
  account: RawAccount | null,
): GameTokenMetadata | null {
  if (
    !account ||
    account.programAddress !== TOKEN_PROGRAM_ID ||
    account.data.length !== getMintSize()
  ) {
    return null;
  }
  const decoded = getMintDecoder().decode(account.data);
  if (!decoded.isInitialized) return null;
  return {
    decimals: decoded.decimals,
    symbol: getTokenSymbol(mint),
  };
}

export async function getGameTokenMetadata(
  rpc: TimbaRpc,
  mints: readonly Address[],
): Promise<Map<string, GameTokenMetadata>> {
  if (mints.length === 0) return new Map();
  const accounts = await fetchEncodedAccounts(rpc, [...mints], {
    commitment: "confirmed",
  });
  return new Map(
    mints.flatMap((mint, index) => {
      const account = accounts[index];
      const metadata = decodeGameTokenMetadata(mint, account?.exists ? account : null);
      return metadata ? [[mint, metadata] as const] : [];
    }),
  );
}

export function decodeGameTokenConfig(mint: Address, account: RawAccount | null): GameTokenConfig {
  const decimals = TOKEN_DECIMALS[mint];
  const symbol = TOKEN_SYMBOLS[mint];
  if (decimals === undefined || !symbol) throw new Error("Unsupported game token");
  if (!account || account.programAddress !== PROGRAM_ID)
    throw new Error(`${symbol} game configuration is unavailable`);
  let decoded;
  try {
    if (identifyTimbaAccount(account.data) !== TimbaAccount.GameToken)
      throw new Error("Wrong account type");
    decoded = getGameTokenDecoder().decode(account.data);
    if (decoded.tokenMint !== mint) throw new Error("Wrong mint");
  } catch {
    throw new Error(`${symbol} game configuration is unavailable`);
  }
  const minimumAmount = decoded.minAmount;
  return {
    mint,
    symbol,
    decimals,
    minimumAmount: formatTokenAmount(minimumAmount, decimals),
    minimumAmountRaw: minimumAmount.toString(),
    enabled: decoded.enabled,
  };
}

export async function getGameTokenConfigs(rpc: TimbaRpc): Promise<GameTokenConfig[]> {
  const mints = Object.keys(TOKEN_SYMBOLS) as Address[];
  const pdas = await Promise.all(mints.map((mint) => getGameTokenPDA(mint)));
  const accounts = await fetchEncodedAccounts(rpc, pdas, {
    commitment: "confirmed",
  });
  return mints.map((mint, index) => {
    const account = accounts[index];
    return decodeGameTokenConfig(mint, account?.exists ? account : null);
  });
}

export async function assertGameTokenAmount(
  rpc: TimbaRpc,
  mint: Address,
  amount: bigint,
): Promise<GameTokenConfig> {
  const gameToken = await getGameTokenPDA(mint);
  const account = await fetchEncodedAccount(rpc, gameToken, {
    commitment: "confirmed",
  });
  const config = decodeGameTokenConfig(mint, account.exists ? account : null);
  if (!config.enabled) {
    throw new CreateGameValidationError(`${config.symbol} is disabled for games`);
  }
  if (amount < BigInt(config.minimumAmountRaw)) {
    throw new CreateGameValidationError(
      `Minimum amount is ${config.minimumAmount} ${config.symbol}`,
    );
  }
  return config;
}

export function assertGameTokenPolicy(
  policies: readonly TokenPolicy[],
  mint: Address,
  amount: bigint,
  metadata: ReadonlyMap<string, GameTokenMetadata>,
): TokenPolicy {
  const result = evaluateTokenPolicy(policies, mint, amount);
  const policy = result.policy;
  if (!policy) throw new CreateGameValidationError("Unsupported game token");
  if (!result.accepted && result.code === "token_disabled") {
    throw new CreateGameValidationError("This token is disabled for new games");
  }
  const token = metadata.get(mint);
  if (!token) throw new CreateGameValidationError("Unsupported game token");
  if (!result.accepted && result.code === "amount_below_minimum") {
    throw new CreateGameValidationError(
      `Minimum amount is ${formatTokenAmount(BigInt(policy.minimumAmountRaw), token.decimals)} ${token.symbol}`,
    );
  }
  return policy;
}

export function formatGameTokenPolicies(
  policies: readonly TokenPolicy[],
  prices: ReadonlyMap<string, number>,
  metadata: ReadonlyMap<string, GameTokenMetadata>,
): GameTokenConfig[] {
  return policies.flatMap((policy) => {
    const token = metadata.get(policy.mint);
    if (!token) return [];
    const minimumAmount = BigInt(policy.minimumAmountRaw);
    return [
      {
        mint: policy.mint,
        symbol: token.symbol,
        decimals: token.decimals,
        minimumAmount: formatTokenAmount(minimumAmount, token.decimals),
        minimumAmountRaw: policy.minimumAmountRaw,
        enabled: policy.enabled,
        priceUsd: prices.get(policy.mint) ?? null,
      },
    ];
  });
}
