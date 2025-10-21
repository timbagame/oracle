import { beforeAll, afterAll, describe, it, expect } from "bun:test";
import { createTestEnv } from "./helpers/create-test-env.ts";
import { resetPendingGames } from "./helpers/reset-pending-games.ts";
import { seedTrackedGame } from "./helpers/seed-tracked-game.ts";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

let OracleService: typeof import("../oracle-service.ts").OracleService;
let OracleDatabase: typeof import("../database.ts").OracleDatabase;
let testEnv: Awaited<ReturnType<typeof createTestEnv>>;

beforeAll(async () => {
  const env = await createTestEnv({
    prefix: "oracle-service-extra-test",
    singletons: {
      OracleService: async () => (await import("../oracle-service.ts")).OracleService,
      OracleDatabase: async () => (await import("../database.ts")).OracleDatabase,
    },
  });

  testEnv = env;
  ({ OracleService, OracleDatabase } = env.singletons);
});

afterAll(() => {
  testEnv.cleanup();
});

async function runExecuteGameCompletionScenario({
  tokenProgram,
  mintOwner,
}: { tokenProgram?: PublicKey | string | null; mintOwner?: PublicKey } = {}) {
  const service = OracleService.createWith(OracleDatabase.getInstance());
  const originalProgram = (service as any).program;
  const originalConfirm = (service as any).confirmTransaction;
  const originalConnection = (service as any).connection;
  const adminKeypair = (service as any).adminKeypair;
  const winner = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  const programId = Keypair.generate().publicKey;
  const tokenMint = Keypair.generate().publicKey;
  const randomHashBuffer = Buffer.alloc(32, 1);
  const secretKeyBuffer = Buffer.alloc(32, 2);
  const calls: { accounts?: any; signers?: any[]; confirmed?: string } = {};
  let directProgram: PublicKey | null = null;

  if (tokenProgram instanceof PublicKey) {
    directProgram = tokenProgram;
  } else if (typeof tokenProgram === "string") {
    directProgram = new PublicKey(tokenProgram);
  } else if (tokenProgram) {
    directProgram = new PublicKey(tokenProgram);
  }

  if (directProgram?.equals(PublicKey.default)) {
    directProgram = null;
  }

  const inferredMintOwner = mintOwner ?? TOKEN_PROGRAM_ID;
  const tokenProgramId = directProgram ?? inferredMintOwner;

  (service as any).connection = {
    getAccountInfo: async (_pubkey: PublicKey) => ({ owner: inferredMintOwner }),
  };

  (service as any).program = {
    programId,
    methods: {
      completeGame: (_rand: number[], _secret: number[], winnerIndex: number) => {
        expect(winnerIndex).toBe(5);
        return {
          accountsPartial: (accs: any) => {
            calls.accounts = accs;
            return {
              signers: (signers: any[]) => {
                calls.signers = signers;
                return {
                  rpc: async () => "tx-abc",
                };
              },
            };
          },
        };
      },
    },
  };

  (service as any).confirmTransaction = async (sig: string) => {
    calls.confirmed = sig;
  };

  let tx = "";

  try {
    const gameAccount: Record<string, unknown> = {
      creator: creator.toBase58(),
      tokenMint: tokenMint.toBase58(),
    };

    if (tokenProgram !== undefined) {
      gameAccount["tokenProgram"] = tokenProgram;
    }

    tx = await (service as any).executeGameCompletion({
      gameAccount,
      winnerAddress: winner,
      randomHashBuffer,
      secretKeyBuffer,
      winnerIndex: 5,
    });
  } finally {
    (service as any).program = originalProgram;
    (service as any).confirmTransaction = originalConfirm;
    (service as any).connection = originalConnection;
  }

  const [expectedGamePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game", "utf8"), randomHashBuffer],
    programId,
  );
  const [expectedOraclePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("oracle", "utf8")],
    programId,
  );
  const [expectedGameTokenPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_token", "utf8"), tokenMint.toBuffer()],
    programId,
  );
  const [expectedGameVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_vault", "utf8"), tokenMint.toBuffer()],
    programId,
  );
  const expectedWinnerAta = getAssociatedTokenAddressSync(
    tokenMint,
    winner,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const expectedGameAta = getAssociatedTokenAddressSync(
    tokenMint,
    expectedGameVaultPda,
    true,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  return {
    tx,
    calls,
    expectedGamePda,
    expectedOraclePda,
    expectedGameTokenPda,
    expectedGameVaultPda,
    expectedWinnerAta,
    expectedGameAta,
    expectedTokenProgram: tokenProgramId,
    oracleOperator: adminKeypair.publicKey,
    winner,
    creator,
    tokenMint,
    adminKeypair,
  };
}

describe("OracleService internals", () => {
  it("isGameReadyForCompletion returns false and marks completed if account missing", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    const addr = Keypair.generate().publicKey.toBase58();
    db.trackGame(addr);
    (service as any).program = {
      account: {
        game: {
          fetch: async () => {
            const e: any = new Error("Account does not exist");
            e.message = "Account does not exist";
            throw e;
          },
        },
      },
    };
    const res = await service.isGameReadyForCompletion(new PublicKey(addr));
    expect(res).toBe(false);
    // now pending list should not contain addr since marked completed
    const pending = db.getPendingGames().map((g) => g.game_address);
    expect(pending.includes(addr)).toBe(false);
  });

  it("isGameReadyForCompletion reports readiness for full and expired lobbies", async () => {
    const service = OracleService.getInstance();
    const originalProgram = (service as any).program;
    const originalConnection = (service as any).connection;

    const now = Math.floor(Date.now() / 1000);
    (service as any).connection = {
      getSlot: async () => 123,
      getBlockTime: async () => now,
    };

    try {
      (service as any).program = {
        account: {
          game: {
            fetch: async () => ({
              ticketsCount: 4,
              maxTickets: 4,
              minTickets: 1,
              timeout: 60,
              createdAt: now - 30,
            }),
          },
        },
      };

      const fullReady = await service.isGameReadyForCompletion(
        new PublicKey(Keypair.generate().publicKey.toBytes()),
      );
      expect(fullReady).toBe(true);

      (service as any).program = {
        account: {
          game: {
            fetch: async () => ({
              ticketsCount: 2,
              maxTickets: 10,
              minTickets: 2,
              timeout: 60,
              createdAt: now - 120,
            }),
          },
        },
      };

      const expiredReady = await service.isGameReadyForCompletion(
        new PublicKey(Keypair.generate().publicKey.toBytes()),
      );
      expect(expiredReady).toBe(true);
    } finally {
      (service as any).program = originalProgram;
      (service as any).connection = originalConnection;
    }
  });

  it("completeGame error cases: missing secret, not ready, no players", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    service.cleanupOldRecords(-1);

    // missing secret
    let res = await service.completeGame("no-secret");
    expect(res.success).toBe(false);

    // not ready
    db.saveSecretKey("not-ready", "deadbeef", "bead");
    // ensure programId exists for PDA derivation inside completeGame
    (service as any).program = {
      programId: Keypair.generate().publicKey,
      account: { game: { fetch: async () => ({ ticketsCount: 1, maxTickets: 10, minTickets: 1, lastSlot: 1 }) } },
    };
    (service as any).isGameReadyForCompletion = async () => false;
    res = await service.completeGame("not-ready");
    expect(res.notReady).toBe(true);

    // no players
    db.saveSecretKey("no-players", "deadbeef", "bead");
    (service as any).isGameReadyForCompletion = async () => true;
    // stub fetch to provide meta for winner calc
    (service as any).program = {
      programId: Keypair.generate().publicKey,
      account: { game: { fetch: async () => ({ ticketsCount: 1, maxTickets: 10, minTickets: 1, lastSlot: 1 }) } },
    };
    res = await service.completeGame("no-players");
    expect(res.success).toBe(false);
    expect(String(res.error || "")).toContain("No players");
  });

  it("completeGame success path marks DB and returns tx hash", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    const gameAddr = "ok-game";
    const players = [
      { address: Keypair.generate().publicKey.toBase58(), ticketIndex: 0 },
      { address: Keypair.generate().publicKey.toBase58(), ticketIndex: 1 },
    ];
    seedTrackedGame(db, {
      service,
      address: gameAddr,
      secret: "a".repeat(64),
      randomHash: "b".repeat(64),
      players,
    });
    (service as any).isGameReadyForCompletion = async () => true;
    (service as any).program = {
      programId: Keypair.generate().publicKey,
      account: { game: { fetch: async () => ({ ticketsCount: 2, maxTickets: 2, minTickets: 1, lastSlot: 123 }) } },
    };
    (service as any).executeGameCompletion = async () => "tx123";

    const res = await service.completeGame(gameAddr);
    expect(res.success).toBe(true);
    expect(res.txHash).toBe("tx123");
    // secret should be marked used
    expect(db.getSecretKey(gameAddr)).toBeNull();
  });

  it("completeGame aborts when ticket registry is out of sync", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();
    const gameAddr = "mismatch-game";
    seedTrackedGame(db, {
      service,
      address: gameAddr,
      secret: "a".repeat(64),
      randomHash: "c".repeat(64),
      players: [
        { address: Keypair.generate().publicKey.toBase58(), ticketIndex: 0 },
      ],
    });

    (service as any).isGameReadyForCompletion = async () => true;
    (service as any).program = {
      programId: Keypair.generate().publicKey,
      account: {
        game: {
          fetch: async () => ({ ticketsCount: 2, maxTickets: 2, minTickets: 1, lastSlot: 456 }),
        },
      },
    };

    const res = await service.completeGame(gameAddr);
    expect(res.success).toBe(false);
    expect(String(res.error || "")).toContain("Ticket registry out of sync");
  });

  it("scanAndCompleteActiveGames clears tracked games lacking secrets", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();

    resetPendingGames(db, { service });

    const orphanGame = "orphaned-game";
    db.trackGame(orphanGame);

    const originalMarkCompleted = db.markGameCompleted.bind(db);
    const marked: string[] = [];
    (db as any).markGameCompleted = (address: string) => {
      marked.push(address);
      originalMarkCompleted(address);
    };

    try {
      const stats = await service.scanAndCompleteActiveGames();
      expect(stats).toEqual({ completed: 0, errors: 0, notReady: 0 });
      expect(marked).toContain(orphanGame);
      const remaining = db.getPendingGames().map((entry) => entry.game_address);
      expect(remaining).not.toContain(orphanGame);
    } finally {
      (db as any).markGameCompleted = originalMarkCompleted;
    }
  });

  it("getBlockchainTime uses network and falls back to wall clock", async () => {
    const service = OracleService.getInstance();
    // happy path
    (service as any).connection = {
      getSlot: async () => 1,
      getBlockTime: async (_slot: number) => 1000,
    };
    expect(await (service as any).getBlockchainTime()).toBe(1000);

    // error path -> fallback to Date.now
    (service as any).connection = {
      getSlot: async () => {
        throw new Error("boom");
      },
      getBlockTime: async () => null,
    };
    const approx = await (service as any).getBlockchainTime();
    expect(Math.abs(approx - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(1);
  });

  it("tryAutoComplete triggers completion and logs failures", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());
    const originalReady = (service as any).isGameReadyForCompletion;
    const originalComplete = (service as any).completeGame;
    const originalError = console.error;

    (service as any).isGameReadyForCompletion = async () => true;

    let invocation = 0;
    const errors: string[] = [];
    console.error = (...args: any[]) => {
      errors.push(args.join(" "));
    };

    try {
      (service as any).completeGame = async () => {
        invocation++;
        if (invocation === 1) {
          return { success: false, error: "nope" };
        }
        if (invocation === 2) {
          return { success: false, notReady: true };
        }
        return { success: true };
      };

      const gamePda = new PublicKey(Keypair.generate().publicKey.toBytes());
      await (service as any).tryAutoComplete(gamePda, "auto-game", "joined");
      await (service as any).tryAutoComplete(gamePda, "auto-game", "joined");
      await (service as any).tryAutoComplete(gamePda, "auto-game", "joined");

      expect(invocation).toBe(3);
      expect(errors.some((entry) => entry.includes("Auto-completion failed"))).toBe(true);
    } finally {
      (service as any).isGameReadyForCompletion = originalReady;
      (service as any).completeGame = originalComplete;
      console.error = originalError;
    }
  });

  it("tryAutoComplete skips completion when readiness checks fail", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());
    const originalReady = (service as any).isGameReadyForCompletion;
    const originalComplete = (service as any).completeGame;

    let completions = 0;
    (service as any).isGameReadyForCompletion = async () => false;
    (service as any).completeGame = async () => {
      completions++;
      return { success: true };
    };

    const gamePda = new PublicKey(Keypair.generate().publicKey.toBytes());

    try {
      await (service as any).tryAutoComplete(gamePda, "guarded-game", "joined");
      expect(completions).toBe(0);

      (service as any).isGameReadyForCompletion = async () => true;
      await (service as any).tryAutoComplete(gamePda, "guarded-game", "joined");
      expect(completions).toBe(1);
    } finally {
      (service as any).isGameReadyForCompletion = originalReady;
      (service as any).completeGame = originalComplete;
    }
  });

  it("completeGame increments attempts for validation failures", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());
    const db = OracleDatabase.getInstance();
    const gameAddr = "validation-failure-game";
    seedTrackedGame(db, {
      service,
      address: gameAddr,
      secret: "a".repeat(64),
      randomHash: "b".repeat(64),
    });

    const originalReady = (service as any).isGameReadyForCompletion;
    const originalProgram = (service as any).program;

    (service as any).isGameReadyForCompletion = async () => true;
    (service as any).program = {
      programId: Keypair.generate().publicKey,
      account: { game: { fetch: async () => ({ ticketsCount: 2, maxTickets: 2, minTickets: 1, lastSlot: 99 }) } },
    };

    try {
      const result = await service.completeGame(gameAddr);
      expect(result.success).toBe(false);
      expect(String(result.error ?? "")).toContain("No players");
      const pending = db.getPendingGames().find((g) => g.game_address === gameAddr);
      expect(pending?.completion_attempts).toBe(1);
    } finally {
      (service as any).isGameReadyForCompletion = originalReady;
      (service as any).program = originalProgram;
      db.markGameCompleted(gameAddr);
      db.markSecretKeyUsed(gameAddr);
      service.cleanupOldRecords(-1);
    }
  });

  it("completeGame increments attempts when execution fails", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());
    const db = OracleDatabase.getInstance();
    const gameAddr = "failing-game";
    seedTrackedGame(db, {
      service,
      address: gameAddr,
      secret: "a".repeat(64),
      randomHash: "b".repeat(64),
      players: [
        { address: Keypair.generate().publicKey.toBase58(), ticketIndex: 0 },
      ],
    });

    const originalReady = (service as any).isGameReadyForCompletion;
    const originalExecute = (service as any).executeGameCompletion;
    const originalProgram = (service as any).program;
    (service as any).isGameReadyForCompletion = async () => true;
    (service as any).program = {
      programId: Keypair.generate().publicKey,
      account: { game: { fetch: async () => ({ ticketsCount: 1, maxTickets: 1, minTickets: 1, lastSlot: 1 }) } },
    };
    (service as any).executeGameCompletion = async () => {
      throw new Error("rpc fail");
    };

    try {
      const result = await service.completeGame(gameAddr);
      expect(result.success).toBe(false);
      expect(String(result.error || "")).toContain("rpc fail");
      const pending = db.getPendingGames().find((g) => g.game_address === gameAddr);
      expect(pending?.completion_attempts).toBe(1);
    } finally {
      (service as any).isGameReadyForCompletion = originalReady;
      (service as any).executeGameCompletion = originalExecute;
      (service as any).program = originalProgram;
    }
  });

  it("scanAndCompleteActiveGames counts unexpected completion errors", async () => {
    const service = OracleService.getInstance();
    const db = OracleDatabase.getInstance();

    resetPendingGames(db, { service });

    const failingGame = "error-prone-game";
    seedTrackedGame(db, {
      address: failingGame,
      secret: "a".repeat(64),
      randomHash: "b".repeat(64),
    });

    const originalExists = (service as any).gameExistsOnChain;
    const originalComplete = (service as any).completeGame;

    let attempts = 0;
    (service as any).gameExistsOnChain = async () => ({
      gamePda: Keypair.generate().publicKey,
      secretData: { secretKey: "aa".repeat(32), randomHash: "bb".repeat(32) },
      readiness: { ready: true, gameAccount: {} },
    });
    (service as any).completeGame = async () => {
      attempts++;
      throw new Error("forced failure");
    };

    try {
      const stats = await service.scanAndCompleteActiveGames();
      expect(stats).toEqual({ completed: 0, errors: 1, notReady: 0 });
      expect(attempts).toBe(1);
    } finally {
      (service as any).gameExistsOnChain = originalExists;
      (service as any).completeGame = originalComplete;
      db.markGameCompleted(failingGame);
      db.markSecretKeyUsed(failingGame);
      service.cleanupOldRecords(-1);
    }
  });

  it("executeGameCompletion invokes RPC and confirms transaction", async () => {
    const result = await runExecuteGameCompletionScenario();

    expect(result.tx).toBe("tx-abc");
    expect(result.calls.accounts?.winner.toBase58()).toBe(result.winner.toBase58());
    expect(result.calls.accounts?.creator.toBase58()).toBe(result.creator.toBase58());
    expect(result.calls.accounts?.oracleOperator.toBase58()).toBe(result.oracleOperator.toBase58());
    expect(result.calls.accounts?.game.toBase58()).toBe(result.expectedGamePda.toBase58());
    expect(result.calls.accounts?.tokenMint.toBase58()).toBe(result.tokenMint.toBase58());
    expect(result.calls.accounts?.oracle.toBase58()).toBe(result.expectedOraclePda.toBase58());
    expect(result.calls.accounts?.gameToken.toBase58()).toBe(result.expectedGameTokenPda.toBase58());
    expect(result.calls.accounts?.gameVault.toBase58()).toBe(result.expectedGameVaultPda.toBase58());
    expect(result.calls.accounts?.tokenProgram.toBase58()).toBe(
      result.expectedTokenProgram.toBase58(),
    );
    expect(result.calls.accounts?.associatedTokenProgram.toBase58()).toBe(
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    );
    expect(result.calls.accounts?.winnerTokenAccount.toBase58()).toBe(
      result.expectedWinnerAta.toBase58(),
    );
    expect(result.calls.accounts?.gameTokenAccount.toBase58()).toBe(result.expectedGameAta.toBase58());
    expect(result.calls.accounts?.systemProgram.toBase58()).toBe(
      anchor.web3.SystemProgram.programId.toBase58(),
    );
    expect(result.calls.signers).toEqual([result.adminKeypair]);
    expect(result.calls.confirmed).toBe("tx-abc");
  });

  it("executeGameCompletion derives Token-2022 accounts when provided", async () => {
    const result = await runExecuteGameCompletionScenario({ tokenProgram: TOKEN_2022_PROGRAM_ID });

    expect(result.tx).toBe("tx-abc");
    expect(result.expectedTokenProgram.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(result.calls.accounts?.tokenProgram.toBase58()).toBe(
      TOKEN_2022_PROGRAM_ID.toBase58(),
    );
    expect(result.calls.accounts?.winnerTokenAccount.toBase58()).toBe(
      result.expectedWinnerAta.toBase58(),
    );
    expect(result.calls.accounts?.gameTokenAccount.toBase58()).toBe(
      result.expectedGameAta.toBase58(),
    );
  });

  it("executeGameCompletion infers Token-2022 accounts from mint owner", async () => {
    const result = await runExecuteGameCompletionScenario({ mintOwner: TOKEN_2022_PROGRAM_ID });

    expect(result.tx).toBe("tx-abc");
    expect(result.expectedTokenProgram.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(result.calls.accounts?.tokenProgram.toBase58()).toBe(
      TOKEN_2022_PROGRAM_ID.toBase58(),
    );
    expect(result.calls.accounts?.winnerTokenAccount.toBase58()).toBe(
      result.expectedWinnerAta.toBase58(),
    );
    expect(result.calls.accounts?.gameTokenAccount.toBase58()).toBe(
      result.expectedGameAta.toBase58(),
    );
  });

  it("executeGameCompletion treats zeroed token program as SPL default", async () => {
    const result = await runExecuteGameCompletionScenario({ tokenProgram: PublicKey.default });

    expect(result.expectedTokenProgram.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(result.calls.accounts?.tokenProgram.toBase58()).toBe(
      TOKEN_PROGRAM_ID.toBase58(),
    );
    expect(result.calls.accounts?.winnerTokenAccount.toBase58()).toBe(
      result.expectedWinnerAta.toBase58(),
    );
    expect(result.calls.accounts?.gameTokenAccount.toBase58()).toBe(
      result.expectedGameAta.toBase58(),
    );
  });

  it("confirmTransaction forwards latest blockhash params", async () => {
    const service = OracleService.createWith(OracleDatabase.getInstance());
    const originalConnection = (service as any).connection;
    const calls: any[] = [];

    (service as any).connection = {
      getLatestBlockhash: async () => ({ blockhash: "bh", lastValidBlockHeight: 42 }),
      confirmTransaction: async (params: any) => {
        calls.push(params);
      },
    };

    try {
      await (service as any).confirmTransaction("sig-1");
      expect(calls[0]).toEqual({ signature: "sig-1", blockhash: "bh", lastValidBlockHeight: 42 });
    } finally {
      (service as any).connection = originalConnection;
    }
  });
});
