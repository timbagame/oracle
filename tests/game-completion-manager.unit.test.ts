import { beforeEach, describe, expect, it } from "bun:test";
import { GameCompletionManager } from "../oracle-completion-manager.ts";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

function createManager(overrides: {
  accountInfo?: (pubkey: PublicKey) => Promise<{ owner: PublicKey | null } | null>;
  programId?: PublicKey;
  secretKeyLength?: number;
} = {}) {
  const secretStore = new Map<string, { secretKey: string; randomHash: string }>();
  const players = new Map<string, string[]>();

  const db = {
    incrementCompletionAttempts: () => {},
    finalizeCompletedGame: () => {},
    getGamePlayers: (address: string) => players.get(address) ?? [],
    getSecretKey: (address: string) => secretStore.get(address) ?? null,
    markGameCompleted: () => {},
  } as const;

  const metrics = {
    recordCompletion: () => {},
    recordScanCycle: () => {},
    recordCleanupSweep: () => {},
  } as const;

  const connection = {
    getAccountInfo: overrides.accountInfo ?? (async () => ({ owner: TOKEN_PROGRAM_ID })),
    getSlot: async () => 100,
    getBlockTime: async () => 1_700_000_000,
  } as const;

  const program = {
    account: { game: { fetch: async () => ({}) } },
    programId: overrides.programId ?? Keypair.generate().publicKey,
    methods: {
      completeGame: () => ({
        accountsPartial: () => ({
          signers: () => ({
            rpc: async () => "tx",
          }),
        }),
      }),
    },
  } as const;

  const readinessCache = new Map<string, any>();
  const tokenProgramCache = new Map<string, PublicKey>();

  const manager = new GameCompletionManager({
    db: db as any,
    metrics,
    getConnection: () => connection as any,
    getProgram: () => program as any,
    adminKeypair: Keypair.generate(),
    readinessCache,
    tokenProgramCache,
    secretKeyLength: overrides.secretKeyLength ?? 32,
    noSecretKeyMessage: "missing",
    confirmTransaction: async () => {},
  });

  return { manager, readinessCache, tokenProgramCache, secretStore, players, connection };
}

describe("GameCompletionManager.calculateWinnerIndex", () => {
  let manager: ReturnType<typeof createManager>["manager"];

  beforeEach(() => {
    ({ manager } = createManager());
  });

  it("is deterministic and stays within player bounds", () => {
    const baseSecret = Buffer.alloc(64);

    const results = new Map<number, Set<number>>();
    let seed = 1;

    const nextBuffer = () => {
      const buf = Buffer.alloc(64);
      for (let i = 0; i < buf.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = seed & 0xff;
      }
      return buf;
    };

    for (let players = 2; players <= 12; players++) {
      const seen = new Set<number>();
      for (let iteration = 0; iteration < 20; iteration++) {
        const secret = iteration === 0 ? baseSecret : nextBuffer();
        const slot = 10_000 + iteration;
        const first = manager.calculateWinnerIndex(secret, slot, players);
        const second = manager.calculateWinnerIndex(secret, slot, players);
        expect(first).toBe(second);
        expect(first).toBeGreaterThanOrEqual(0);
        expect(first).toBeLessThan(players);
        seen.add(first);
      }
      results.set(players, seen);
    }

    for (const [players, seen] of results) {
      expect(seen.size).toBeGreaterThan(1);
      expect([...seen].every((value) => value < players)).toBe(true);
    }
  });

  it("throws when the secret is shorter than the configured length", () => {
    expect(() => manager.calculateWinnerIndex(Buffer.alloc(16), 1, 2)).toThrow(
      "Secret key buffer must be at least 32 bytes"
    );
  });
});

describe("GameCompletionManager.resolveTokenProgram", () => {
  it("returns direct program ids and caches them", async () => {
    const { manager, tokenProgramCache } = createManager();
    const mint = Keypair.generate().publicKey;

    const program = await manager.resolveTokenProgram(TOKEN_2022_PROGRAM_ID, mint);
    expect(program.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(tokenProgramCache.get(mint.toBase58())).toEqual(TOKEN_2022_PROGRAM_ID);
  });

  it("queries mint accounts when program id is missing and memoizes the result", async () => {
    let lookups = 0;
    const owner = TOKEN_PROGRAM_ID;
    const { manager, connection, tokenProgramCache } = createManager({
      accountInfo: async (_pubkey) => {
        lookups += 1;
        return { owner };
      },
    });

    const mint = Keypair.generate().publicKey;
    const program = await manager.resolveTokenProgram(PublicKey.default, mint);
    expect(program.equals(owner)).toBe(true);
    expect(lookups).toBe(1);

    const cached = await manager.resolveTokenProgram(PublicKey.default, mint);
    expect(cached.equals(owner)).toBe(true);
    expect(lookups).toBe(1);
    expect(tokenProgramCache.get(mint.toBase58())).toEqual(owner);
    expect(connection.getAccountInfo).toBeDefined();
  });

  it("throws when the mint owner is unsupported", async () => {
    const unsupported = Keypair.generate().publicKey;
    const { manager } = createManager({
      accountInfo: async () => ({ owner: unsupported }),
    });

    const mint = Keypair.generate().publicKey;

    await expect(
      manager.resolveTokenProgram(PublicKey.default, mint)
    ).rejects.toThrow(`Unsupported token program owner ${unsupported.toBase58()}`);
  });
});
