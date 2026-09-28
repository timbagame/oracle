import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  compileTransaction,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
  type Address,
  type Transaction,
} from "@solana/kit";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import {
  getGameEncoder as getGameEncoderV020,
  getGameTokenEncoder,
} from "@timbagame/protocol/contracts/v0.2.0/kit";
import { getGameEncoder as getGameEncoderV030 } from "@timbagame/protocol/contracts/v0.3.0/kit";
import { createWebGameApi } from "../web-api/api.ts";
import { PROGRAM_ID, getGameTokenPDA } from "../web-api/program.ts";
import { contractCapabilities, contractVersion } from "../web-api/contract-version.ts";
import { TOKEN_PROGRAM_ID } from "../web-api/token-program.ts";
import { TOKEN_SYMBOLS, USDC_MINT } from "../web-api/token-utils.ts";
import type { OracleRpc } from "../solana-kit.ts";
import { setupTestEnvironment } from "./helpers/setup-env.ts";

type OracleDouble = Parameters<typeof createWebGameApi>[0];

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

let cleanup: () => void;
let fetchGuard: { mockRestore: () => void };
beforeAll(() => {
  // Token config reads the oracle config; keep Jupiter disabled so no price lookup leaves the process.
  ({ cleanup } = setupTestEnvironment({
    prefix: "web-api-routes",
    env: { JUPITER_API_KEY: undefined, JUPITER_API_KEY_FILE: undefined },
  }));
  fetchGuard = spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new Error("unexpected network request in web API test");
  }) as unknown as typeof fetch);
});
afterAll(() => {
  fetchGuard.mockRestore();
  cleanup();
});

function encodedAccount(data: Uint8Array, owner: Address) {
  return {
    data: [Buffer.from(data).toString("base64"), "base64"],
    owner,
    lamports: 1n,
    executable: false,
    space: BigInt(data.length),
    rentEpoch: 0n,
  };
}

function mintAccount(decimals: number) {
  return encodedAccount(
    getMintEncoder().encode({
      mintAuthority: null,
      supply: 1_000_000n,
      decimals,
      isInitialized: true,
      freezeAuthority: null,
    }) as Uint8Array,
    TOKEN_PROGRAM_ID,
  );
}

/**
 * Serves mint accounts for every supported token and, for v0.2 deployments, the
 * per-token configuration PDAs, so both token-config paths see the same chain.
 */
async function tokenChain() {
  const accounts = new Map<string, unknown>();
  for (const mint of Object.keys(TOKEN_SYMBOLS) as Address[]) {
    accounts.set(mint, mintAccount(6));
    accounts.set(
      await getGameTokenPDA(mint),
      encodedAccount(
        getGameTokenEncoder().encode({
          tokenMint: mint,
          vaultBump: 255,
          minAmount: 1_000n,
          feeAmount: 0n,
          enabled: true,
        }) as Uint8Array,
        PROGRAM_ID,
      ),
    );
  }
  return accounts;
}

function rpcFor(accounts: Map<string, unknown>, extra: Record<string, () => unknown> = {}) {
  const calls: string[] = [];
  const rpc = new Proxy(
    {},
    {
      get(_target, method: string) {
        return (...args: unknown[]) => {
          calls.push(method);
          return {
            send: async () => {
              if (method === "getMultipleAccounts") {
                return {
                  context: { slot: 1n },
                  value: (args[0] as string[]).map((key) => accounts.get(key) ?? null),
                };
              }
              if (method === "getAccountInfo") {
                return { context: { slot: 1n }, value: accounts.get(args[0] as string) ?? null };
              }
              const handler = extra[method];
              if (!handler) throw new Error(`unexpected rpc ${method}`);
              return handler();
            },
          };
        };
      },
    },
  ) as unknown as OracleRpc;
  return { rpc, calls };
}

function createApi(
  rpc: OracleRpc,
  overrides: Partial<OracleDouble> = {},
  database: Parameters<typeof createWebGameApi>[1] = {
    getVerifiedGame: () => null,
    saveVerifiedGame: () => {},
  },
) {
  const oracle: OracleDouble = {
    getConnection: () => rpc,
    getProgramId: () => PROGRAM_ID,
    getTokenPolicies: async () =>
      Object.keys(TOKEN_SYMBOLS).map((mint) => ({
        mint,
        enabled: true,
        minimumAmountRaw: "1000",
        acceptedMinimumAmountRaw: "950",
        revision: 1,
        effectiveAt: "2026-01-01T00:00:00.000Z",
      })),
    generateGameSecrets: async () => {
      throw new Error("unexpected secret generation");
    },
    signGameTransaction: async () => {
      throw new Error("unexpected signing");
    },
    ...overrides,
  };
  return createWebGameApi(oracle, database);
}

function freezeClock(start: number) {
  let now = start;
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  restores.push(() => spy.mockRestore());
  return (ms: number) => {
    now += ms;
  };
}

/**
 * The contract generation is fixed when the module loads. Deployments without per-token game
 * accounts (v0.3) take creation minimums from the oracle's token policy instead.
 */
function useOracleTokenPolicies() {
  const previous = contractCapabilities.gameTokenAccount;
  (contractCapabilities as { gameTokenAccount: boolean }).gameTokenAccount = false;
  restores.push(() => {
    (contractCapabilities as { gameTokenAccount: boolean }).gameTokenAccount = previous;
  });
}

/**
 * Lets background work (PDA hashing, RPC doubles) settle without a timed sleep. With a `done`
 * condition it keeps yielding until the condition holds, bounded generously so a loaded CI runner
 * still gets there; without one it yields a fixed number of turns.
 */
async function settle(done?: () => boolean, ticks = done ? 10_000 : 50): Promise<void> {
  for (let index = 0; index < ticks && !done?.(); index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("web game API token config", () => {
  test("lists every supported token with its creation minimum", async () => {
    const { rpc } = rpcFor(await tokenChain());
    const handler = createApi(rpc);

    const response = await handler(new Request("http://oracle/web/config"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=5, s-maxage=10");
    const body = (await response.json()) as {
      tokens: Array<{
        mint: string;
        minimumAmountRaw: string;
        enabled: boolean;
        priceUsd: number | null;
      }>;
    };
    expect(body.tokens.map((token) => token.mint).sort()).toEqual(
      Object.keys(TOKEN_SYMBOLS).sort(),
    );
    const usdc = body.tokens.find((token) => token.mint === USDC_MINT)!;
    expect(usdc.minimumAmountRaw).toBe("1000");
    expect(usdc.enabled).toBe(true);
    expect(usdc.priceUsd).toBeNull();
  });

  test("serves the fresh value from memory, then stale-while-revalidate, then refreshes", async () => {
    const advance = freezeClock(1_800_000_000_000);
    const { rpc, calls } = rpcFor(await tokenChain());
    const handler = createApi(rpc);
    const config = () => handler(new Request("http://oracle/web/config"));
    const reads = () => calls.filter((method) => method === "getMultipleAccounts").length;

    await config();
    const afterFirst = reads();
    await config();
    expect(reads()).toBe(afterFirst);

    advance(6_000);
    const stale = await config();
    expect(stale.status).toBe(200);
    await settle(() => reads() >= afterFirst * 2);
    expect(reads()).toBe(afterFirst * 2);

    advance(10 * 60_000);
    await config();
    expect(reads()).toBe(afterFirst * 3);
  });

  test("shares one in-flight refresh between concurrent requests", async () => {
    const { rpc, calls } = rpcFor(await tokenChain());
    const handler = createApi(rpc);

    const responses = await Promise.all([
      handler(new Request("http://oracle/web/config")),
      handler(new Request("http://oracle/web/config")),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const single = calls.filter((method) => method === "getMultipleAccounts").length;
    const { rpc: rpc2, calls: calls2 } = rpcFor(await tokenChain());
    await createApi(rpc2)(new Request("http://oracle/web/config"));
    expect(single).toBe(calls2.filter((method) => method === "getMultipleAccounts").length);
  });

  test("keeps serving a stale config when the background refresh fails", async () => {
    const advance = freezeClock(1_800_000_000_000);
    const accounts = await tokenChain();
    const { rpc } = rpcFor(accounts);
    let failPolicies = false;
    const handler = createApi(rpc, {
      getTokenPolicies: async () => {
        if (failPolicies) throw new Error("policy store offline");
        return Object.keys(TOKEN_SYMBOLS).map((mint) => ({
          mint,
          enabled: true,
          minimumAmountRaw: "1000",
          acceptedMinimumAmountRaw: "950",
          revision: 1,
          effectiveAt: "2026-01-01T00:00:00.000Z",
        }));
      },
    });
    const first = await (await handler(new Request("http://oracle/web/config"))).json();

    failPolicies = true;
    accounts.clear();
    advance(6_000);
    const stale = await handler(new Request("http://oracle/web/config"));
    await settle();

    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual(first);
  });
});

describe("web game API token config from oracle policies", () => {
  test("lists tokens with the minimums from the oracle token policy", async () => {
    useOracleTokenPolicies();
    const { rpc, calls } = rpcFor(await tokenChain());
    let policyReads = 0;
    const handler = createApi(rpc, {
      getTokenPolicies: async () => {
        policyReads += 1;
        return [
          {
            mint: USDC_MINT,
            enabled: true,
            minimumAmountRaw: "2500",
            acceptedMinimumAmountRaw: "2400",
            revision: 3,
            effectiveAt: "2026-01-01T00:00:00.000Z",
          },
        ];
      },
    });

    const response = await handler(new Request("http://oracle/web/config"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tokens: Array<{ mint: string; minimumAmountRaw: string; enabled: boolean }>;
    };
    expect(body.tokens).toEqual([
      expect.objectContaining({ mint: USDC_MINT, minimumAmountRaw: "2500", enabled: true }),
    ]);
    expect(policyReads).toBe(1);
    expect(calls).not.toContain("getProgramAccounts");
  });
});

describe("web game API verification", () => {
  const signature = getBase58Decoder().decode(new Uint8Array(64).fill(9));

  test("serves a previously verified game with an immutable cache policy", async () => {
    const { rpc, calls } = rpcFor(new Map());
    const reads: string[] = [];
    const handler = createApi(
      rpc,
      {},
      {
        getVerifiedGame: (key) => {
          reads.push(key);
          return JSON.stringify({ signature, winner: "cached" });
        },
        saveVerifiedGame: () => {
          throw new Error("unexpected write");
        },
      },
    );

    const response = await handler(new Request(`http://oracle/web/verification/${signature}`));

    expect(await response.json()).toEqual({ signature, winner: "cached" });
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, s-maxage=31536000, immutable",
    );
    expect(reads[0]).toEndWith(`:verification-v2:${signature}`);
    expect(calls).toEqual([]);
  });

  test("reports an unavailable service when the chain lookup fails", async () => {
    const { rpc } = rpcFor(new Map());
    const handler = createApi(rpc);

    const response = await handler(new Request(`http://oracle/web/verification/${signature}`));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({ error: "Game service temporarily unavailable" });
  });
});

describe("web game API submission", () => {
  async function signedTransaction(signers: number): Promise<Transaction> {
    const payer = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const compiled = compileTransaction({
      version: "legacy",
      feePayer: { address: payer.address },
      lifetimeConstraint: {
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 10n,
      },
      instructions: [
        {
          programAddress: PROGRAM_ID,
          accounts: [{ address: other.address, role: 2 }],
          data: new Uint8Array([1]),
        },
      ],
    } as never);
    return partiallySignTransaction(
      signers === 2 ? [payer.keyPair, other.keyPair] : [payer.keyPair],
      compiled,
    );
  }

  const submit = (body: unknown, contentType = "application/json") =>
    new Request("http://oracle/web/games/submit", {
      method: "POST",
      headers: { "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  test("broadcasts the oracle co-signed transaction", async () => {
    const signed = getBase64EncodedWireTransaction(await signedTransaction(2));
    const sent: string[] = [];
    const broadcast = getBase58Decoder().decode(new Uint8Array(64).fill(3));
    const { rpc } = rpcFor(new Map(), {
      sendTransaction: () => broadcast,
    });
    const originalSend = (rpc as unknown as Record<string, (...args: unknown[]) => unknown>)[
      "sendTransaction"
    ]!;
    const recordingRpc = new Proxy(rpc as object, {
      get(target, method: string) {
        if (method !== "sendTransaction") return Reflect.get(target, method);
        return (wire: string, config: unknown) => {
          sent.push(wire);
          expect(config).toEqual({ encoding: "base64", preflightCommitment: "confirmed" });
          return originalSend(wire, config);
        };
      },
    }) as OracleRpc;
    const signatures: string[] = [];
    const handler = createApi(recordingRpc, {
      signGameTransaction: async (payload) => {
        signatures.push(payload);
        return signed;
      },
    });

    const creatorSigned = getBase64EncodedWireTransaction(await signedTransaction(1));
    const response = await handler(submit({ txBase64: creatorSigned }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signature: broadcast });
    expect(signatures).toEqual([creatorSigned]);
    expect(sent).toEqual([signed]);
  });

  test("refuses to broadcast a transaction that is still missing signatures", async () => {
    const partial = getBase64EncodedWireTransaction(await signedTransaction(1));
    const { rpc, calls } = rpcFor(new Map());
    const handler = createApi(rpc, { signGameTransaction: async () => partial });

    const response = await handler(submit({ txBase64: partial }));

    expect(response.status).toBe(503);
    expect(calls).not.toContain("sendTransaction");
    expect(
      Object.values(
        getTransactionDecoder().decode(getBase64Encoder().encode(partial)).signatures,
      ).some((value) => value === null),
    ).toBe(true);
  });

  test("rejects malformed submission bodies", async () => {
    const { rpc } = rpcFor(new Map());
    const handler = createApi(rpc);

    const cases = [
      [submit({ nope: true }), "Invalid transaction"],
      [submit("{", "application/json"), "Invalid JSON"],
      [submit({ txBase64: "x" }, "text/plain"), "Expected JSON"],
    ] as const;
    for (const [request, message] of cases) {
      const response = await handler(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: message });
    }
  });
});

describe("web game API preparation guards", () => {
  const prepare = (headers: Record<string, string> = {}) =>
    new Request("http://oracle/web/games/prepare", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        creator: "HGBiGfyR9GF36J4SMPjxsRkFuwYNuNYuzdCjgR4aw4FC",
        tokenMint: USDC_MINT,
        type: "giveaway",
        amount: "1000000",
        minPlayers: 1,
        maxPlayers: 2,
        timeoutSeconds: 600,
      }),
    });

  test("rejects a web build compiled for another contract version", async () => {
    const { rpc, calls } = rpcFor(new Map());
    const handler = createApi(rpc);

    const response = await handler(prepare({ "x-timba-contract-version": "9.9.9" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Game contract configuration mismatch" });
    expect(calls).toEqual([]);
  });

  test("fails closed when the oracle does not report its operator", async () => {
    const { rpc } = rpcFor(await tokenChain());
    const handler = createApi(rpc, {
      generateGameSecrets: async () => ({
        randomHash: "07".repeat(32),
        gameAddress: "HGBiGfyR9GF36J4SMPjxsRkFuwYNuNYuzdCjgR4aw4FC",
      }),
    });

    const response = await handler(prepare({ "x-timba-contract-version": contractVersion }));

    expect(response.status).toBe(503);
  });
});

describe("web game API preparation with oracle token policies", () => {
  const prepare = (amount: string) =>
    new Request("http://oracle/web/games/prepare", {
      method: "POST",
      headers: { "content-type": "application/json", "x-timba-contract-version": contractVersion },
      body: JSON.stringify({
        creator: "HGBiGfyR9GF36J4SMPjxsRkFuwYNuNYuzdCjgR4aw4FC",
        tokenMint: USDC_MINT,
        type: "giveaway",
        amount,
        minPlayers: 1,
        maxPlayers: 2,
        timeoutSeconds: 600,
      }),
    });

  test("rejects amounts below the oracle policy minimum before generating secrets", async () => {
    useOracleTokenPolicies();
    const { rpc } = rpcFor(await tokenChain());
    let secrets = 0;
    const handler = createApi(rpc, {
      generateGameSecrets: async () => {
        secrets += 1;
        throw new Error("unexpected secret generation");
      },
    });

    const response = await handler(prepare("10"));

    expect(response.status).toBe(400);
    expect(secrets).toBe(0);
  });

  test("checks the policy minimum and then requests game secrets", async () => {
    useOracleTokenPolicies();
    const { rpc } = rpcFor(await tokenChain());
    let secrets = 0;
    const handler = createApi(rpc, {
      generateGameSecrets: async () => {
        secrets += 1;
        return {
          randomHash: "07".repeat(32),
          gameAddress: "HGBiGfyR9GF36J4SMPjxsRkFuwYNuNYuzdCjgR4aw4FC",
        };
      },
    });

    const response = await handler(prepare("1000000"));

    expect(secrets).toBe(1);
    expect(response.status).toBe(503);
  });
});

describe("web game API game lookup", () => {
  async function gameAccount() {
    const creator = (await generateKeyPairSigner()).address;
    const encoder = contractVersion === "0.3.0" ? getGameEncoderV030() : getGameEncoderV020();
    return encoder.encode({
      creator,
      gameType: 0,
      ticketAmount: 250n,
      maxTickets: 2,
      minTickets: 2,
      ticketsCount: 1,
      tokenMint: USDC_MINT,
      createdAt: 1_000n,
      timeout: 600n,
      lastSlot: 42n,
      isPrivate: false,
      totalAmount: 250n,
      participants: [creator],
    } as never) as Uint8Array;
  }

  test("decodes an on-chain game and honours the fresh flag", async () => {
    const game = (await generateKeyPairSigner()).address;
    const accounts = new Map<string, unknown>([
      [game, encodedAccount(await gameAccount(), PROGRAM_ID)],
    ]);
    const { rpc } = rpcFor(accounts);
    const handler = createApi(rpc);

    const cached = await handler(new Request(`http://oracle/web/games/${game}`));
    const fresh = await handler(new Request(`http://oracle/web/games/${game}?fresh=1`));

    expect(cached.headers.get("cache-control")).toBe("public, max-age=2, s-maxage=2");
    expect(fresh.headers.get("cache-control")).toBe("no-store");
    expect(await cached.json()).toMatchObject({
      address: game,
      type: "coinflip",
      tokenMint: USDC_MINT,
      stakeAmount: "250",
      currentPlayers: 1,
      lastSlot: "42",
    });
  });

  test("returns 404 for a missing game account", async () => {
    const { rpc } = rpcFor(new Map());
    const handler = createApi(rpc);
    const game = (await generateKeyPairSigner()).address;

    const response = await handler(new Request(`http://oracle/web/games/${game}`));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Game not found" });
  });

  test("rejects accounts owned by another program", async () => {
    const game = (await generateKeyPairSigner()).address;
    const { rpc } = rpcFor(
      new Map([[game, encodedAccount(await gameAccount(), TOKEN_PROGRAM_ID)]]),
    );
    const handler = createApi(rpc);

    const response = await handler(new Request(`http://oracle/web/games/${game}`));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid game account" });
  });
});

test("mint fixtures match the SPL mint layout", () => {
  expect(Buffer.from(mintAccount(6).data[0] as string, "base64")).toHaveLength(getMintSize());
});
