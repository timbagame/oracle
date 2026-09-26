import { spyOn } from "bun:test";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { EvmConfig } from "../../evm/config.ts";
import { EvmService } from "../../evm/service.ts";
import { EvmStore } from "../../evm/store.ts";

export const OPERATOR_KEY = `0x${"1".padStart(64, "0")}` as Hex;
export const CREATOR_KEY = `0x${"2".padStart(64, "0")}` as Hex;
export const PLAYER_KEY = `0x${"3".padStart(64, "0")}` as Hex;
export const TOKEN = "0x2222222222222222222222222222222222222222" as const;
export const PROXY = "0x1111111111111111111111111111111111111111" as const;

export const operatorAccount = privateKeyToAccount(OPERATOR_KEY);
export const creatorAccount = privateKeyToAccount(CREATOR_KEY);
export const playerAccount = privateKeyToAccount(PLAYER_KEY);

/** Oracle config tuple: feePercentage, buffer, minTimeout, maxTimeout, maxPlayers. */
export const ORACLE_LIMITS = [5, 600, 300, 86_400, 10] as const;

export function createEvmConfig(overrides: Partial<EvmConfig> = {}): EvmConfig {
  return {
    chainId: 31337,
    address: PROXY,
    version: "0.1.0",
    rpcUrls: ["http://127.0.0.1:1"],
    startBlock: "0",
    confirmations: 2,
    pollMs: 250,
    database: ":memory:",
    operatorKeyFile: "unused",
    apiTokenFile: "unused",
    port: 3002,
    tokens: [{ address: TOKEN, symbol: "TEST", decimals: 18, minimumAmount: "100" }],
    ...overrides,
  };
}

export type FakeGame = {
  creator: Hex;
  token: Hex;
  gameType: number;
  status: number;
  isPrivate: boolean;
  minPlayers: number;
  maxPlayers: number;
  expiresAt: bigint;
  ticketAmount: bigint;
  totalAmount: bigint;
  commitment: Hex;
  lastEntryBlock: bigint;
  participants: readonly Hex[];
};

export function fakeGame(overrides: Partial<FakeGame> = {}): FakeGame {
  return {
    creator: creatorAccount.address,
    token: TOKEN,
    gameType: 0,
    status: 1,
    isPrivate: false,
    minPlayers: 2,
    maxPlayers: 2,
    expiresAt: 10_000n,
    ticketAmount: 100n,
    totalAmount: 200n,
    commitment: `0x${"00".repeat(32)}`,
    lastEntryBlock: 5n,
    participants: [creatorAccount.address, playerAccount.address],
    ...overrides,
  };
}

export type FakeChain = {
  now: bigint;
  chainId: number;
  owner: Hex;
  limits: readonly [number, number, number, number, number];
  creationNonce: bigint;
  games: Map<string, FakeGame>;
  validSignature: boolean;
};

/**
 * Builds an EvmService whose public client answers from an in-memory chain
 * instead of an RPC endpoint. Wallet signing stays real (local account).
 */
export function createFakeEvmService(options: { config?: Partial<EvmConfig> } = {}) {
  const store = new EvmStore(":memory:", "fake-chain");
  const service = new EvmService(createEvmConfig(options.config), OPERATOR_KEY, store);
  const chain: FakeChain = {
    now: 1_000n,
    chainId: 31337,
    owner: operatorAccount.address,
    limits: ORACLE_LIMITS,
    creationNonce: 0n,
    games: new Map(),
    validSignature: true,
  };
  const client = service.publicClient as unknown as Record<string, (...args: never[]) => unknown>;
  const spies = [
    spyOn(client, "getChainId").mockImplementation(async () => chain.chainId),
    spyOn(client, "getBlock").mockImplementation(async () => ({
      timestamp: chain.now,
      hash: `0x${"ab".repeat(32)}`,
    })),
    spyOn(client, "readContract").mockImplementation((async (call: {
      functionName: string;
      args?: unknown[];
    }) => {
      switch (call.functionName) {
        case "owner":
          return chain.owner;
        case "config":
          return chain.limits;
        case "creationNonces":
          return chain.creationNonce;
        case "getGame": {
          const game = chain.games.get(String(call.args?.[0]));
          if (!game) throw new Error(`unknown game ${String(call.args?.[0])}`);
          return game;
        }
        default:
          throw new Error(`unexpected readContract ${call.functionName}`);
      }
    }) as never),
    spyOn(client, "verifyTypedData").mockImplementation(async () => chain.validSignature),
    // Any call that slips past the fakes must fail loudly instead of reaching the network.
    spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("unexpected network request in EVM test");
    }) as unknown as typeof fetch),
  ];
  return {
    service,
    store,
    chain,
    client,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
      store.close();
    },
  };
}
