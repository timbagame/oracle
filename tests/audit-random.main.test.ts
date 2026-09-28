import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as readline from "node:readline/promises";
import { OracleDatabase } from "../database.ts";
import { OracleService } from "../oracle-service.ts";
import { main, runCli } from "../scripts/audit-random.ts";
import { captureConsole, createRestorer } from "./helpers/cli.ts";

const GAME = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";
const OTHER_GAME = "HGBiGfyR9GF36J4SMPjxsRkFuwYNuNYuzdCjgR4aw4FC";
const PLAYER_A = "So11111111111111111111111111111111111111112";
const PLAYER_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PLAYER_C = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SECRET = "ab".repeat(32);

const restorer = createRestorer();
afterEach(() => restorer.restoreAll());

type Listener = (event: unknown, slot?: number) => Promise<void>;
type Poll = {
  slot?: number | Error;
  account?: Record<string, bigint> | null | Error;
  /** Runs while the game account is fetched, e.g. to deliver program events mid-poll. */
  during?: (listeners: Map<string, Listener>) => Promise<void>;
};

const account = (overrides: Record<string, bigint> = {}) => ({
  ticketsCount: 2n,
  lastSlot: 100n,
  createdAt: 1_700_000_000n,
  timeout: 600n,
  ...overrides,
});

function fakeAuditEnvironment(options: {
  polls: Poll[];
  secrets?: Record<string, { secretKey: string; used: boolean }>;
  players?: string[] | Error;
  pending?: Array<{ game_address: string; completion_attempts: number }>;
  answers?: string[];
}) {
  const screen: string[] = [];
  restorer.track(
    spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      screen.push(String(chunk));
      return true;
    }) as never),
  );
  const delays: number[] = [];
  restorer.track(
    spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
      delays.push(ms);
      setImmediate(callback);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout),
  );
  const answers = [...(options.answers ?? [])];
  const questions: string[] = [];
  let promptsClosed = 0;
  restorer.track(
    spyOn(readline, "createInterface").mockImplementation((() => ({
      question: async (prompt: string) => {
        questions.push(prompt);
        return answers.shift() ?? "";
      },
      close: () => {
        promptsClosed += 1;
      },
    })) as never),
  );

  const secrets = options.secrets ?? { [GAME]: { secretKey: SECRET, used: false } };
  const mutations: unknown[] = [];
  let playerReads = 0;
  restorer.track(
    spyOn(OracleDatabase, "getInstance").mockReturnValue({
      getPendingGames: () => options.pending ?? [],
      getSecretKeyInfo: (address: string) => secrets[address] ?? null,
      getGameStatus: (address: string) => (address === OTHER_GAME ? "pending" : null),
      getGamePlayers: () => {
        playerReads += 1;
        if (options.players instanceof Error) throw options.players;
        return options.players ?? [PLAYER_A, PLAYER_B];
      },
      applyPlayerMutations: (address: string, applied: unknown[]) => {
        mutations.push([address, ...applied]);
      },
    } as never),
  );

  const polls = [...options.polls];
  let current: Poll = {};
  const listeners = new Map<string, Listener>();
  const removed: number[] = [];
  let stopped = 0;
  const winnerInputs: Array<[number, number]> = [];
  restorer.track(
    spyOn(OracleService, "getInstance").mockResolvedValue({
      completionManager: {
        calculateWinnerIndex: (secret: Buffer, slot: number, players: number) => {
          expect(secret.toString("hex")).toBe(SECRET);
          winnerInputs.push([slot, players]);
          return slot % players;
        },
      },
      getConnection: () => ({
        getSlot: () => ({
          send: async () => {
            current = polls.shift() ?? {};
            if (current.slot instanceof Error) throw current.slot;
            return BigInt(current.slot ?? 200);
          },
        }),
        getBlockTime: () => ({ send: async () => 1_700_000_100n }),
      }),
      program: {
        fetchGame: async () => {
          await current.during?.(listeners);
          if (current.account instanceof Error) throw current.account;
          return current.account === undefined ? account() : current.account;
        },
        addEventListener: async (name: string, listener: Listener) => {
          listeners.set(name, listener);
          return listeners.size;
        },
        removeEventListener: async (id: number) => {
          removed.push(id);
        },
      },
      stopEventListening: async () => {
        stopped += 1;
      },
    } as never),
  );

  return {
    screen,
    delays,
    questions,
    mutations,
    listeners,
    removed,
    winnerInputs,
    get frames() {
      return screen.join("").split("\x1Bc").filter(Boolean);
    },
    get stopped() {
      return stopped;
    },
    get playerReads() {
      return playerReads;
    },
    get promptsClosed() {
      return promptsClosed;
    },
  };
}

describe("audit-random CLI", () => {
  test("renders one audit frame with the winner now and after one more join", async () => {
    const audit = fakeAuditEnvironment({ polls: [{ slot: 200 }] });

    await main([GAME, "--once", "--no-listen", "--with-block-time", "--slots", "4"]);

    expect(audit.frames).toHaveLength(1);
    const frame = audit.frames[0]!;
    expect(frame).toContain(`Game: ${GAME}`);
    expect(frame).toContain("Status: active");
    expect(frame).toContain("Slot: 200 | BlockTime: 2023-11-14T22:15:00.000Z");
    expect(frame).toContain("Tickets: 2 | Players(DB): 2 | lastSlot(entropy): 100");
    expect(frame).toContain("ExpiresAt: 2023-11-14T22:23:20.000Z");
    expect(frame).toContain(`Winner if completes now: ${PLAYER_A} (index=0, position=1)`);
    expect(frame).toContain("If 1 new ticket joins at future slot (n=3):");
    expect(frame).toContain("201 -> index=   0 pos=   1");
    expect(frame).toContain("winner=<new join>");
    expect(frame).toContain("Win probability (next 4 slots):");
    expect(frame).toContain("Ctrl+C to exit.");
    expect(audit.winnerInputs).toEqual([
      [100, 2],
      [201, 3],
      [202, 3],
      [203, 3],
      [204, 3],
    ]);
    expect(audit.listeners.size).toBe(0);
    expect(audit.stopped).toBe(1);
  });

  test("follows program events, backs off on rate limits and exits once the game completes", async () => {
    const audit = fakeAuditEnvironment({
      players: [PLAYER_A],
      polls: [
        { slot: 200, account: account({ ticketsCount: 1n }) },
        {
          slot: new Error("429 Too Many Requests"),
          during: async (listeners) => {
            await listeners.get("playerJoined")!(
              { gameAddress: GAME, playerAddress: PLAYER_B, ticketIndex: 1 },
              205,
            );
            await listeners.get("playerJoined")!(
              { gameAddress: OTHER_GAME, playerAddress: PLAYER_C, ticketIndex: 0 },
              205,
            );
            await listeners.get("playerUnjoined")!({ gameAddress: GAME, ticketIndex: 0 });
            await listeners.get("gameClosed")!({ gameAddress: OTHER_GAME }, 206);
            await listeners.get("gameCompleted")!(null);
          },
        },
        {
          slot: 220,
          during: async (listeners) => {
            await listeners.get("gameCompleted")!({ gameKey: GAME }, 219);
          },
        },
      ],
    });

    await main(["--game", GAME, "--interval", "1000", "--write-db"]);

    expect([...audit.listeners.keys()]).toEqual([
      "playerJoined",
      "playerUnjoined",
      "gameCompleted",
      "gameClosed",
    ]);
    expect(audit.delays).toEqual([1_000, 2_000]);
    expect(audit.mutations).toEqual([
      [GAME, { action: "joined", playerAddress: PLAYER_B, ticketIndex: 1 }],
      [GAME, { action: "unjoined", ticketIndex: 0, movedParticipant: undefined }],
    ]);
    const [first, rateLimited, completed] = audit.frames;
    expect(first).toContain("Last joiner: n/a");
    expect(rateLimited).toContain("RPC slot/time: 429 Too Many Requests");
    expect(rateLimited).toContain("n/a (slot unavailable)");
    expect(rateLimited).toContain(`Last joiner: ${PLAYER_B} (ticketIndex=1, joinedSlot=205`);
    expect(completed).toContain("Status: completed");
    expect(completed).toContain("CompletedSlot: 219");
    expect(completed).toContain("Completed. Exiting...");
    expect(audit.removed).toEqual([1, 2, 3, 4]);
    expect(audit.stopped).toBe(1);
  });

  test("treats a missing game account as completed", async () => {
    const audit = fakeAuditEnvironment({
      secrets: { [GAME]: { secretKey: SECRET, used: true } },
      players: [PLAYER_A, PLAYER_B, PLAYER_C],
      polls: [{ slot: 300, account: new Error("Account does not exist") }],
    });

    await main([GAME, "--no-listen", "--db-refresh"]);

    const frame = audit.frames[0]!;
    expect(frame).toContain("Status: completed");
    expect(frame).toContain("Winner if completes now: n/a");
    expect(frame).toContain("Completed. Exiting...");
    expect(audit.playerReads).toBe(2);
  });

  test("reports registry mismatches and database refresh failures", async () => {
    const audit = fakeAuditEnvironment({
      players: new Error("database is locked"),
      polls: [{ slot: 300, account: account({ ticketsCount: 3n }) }],
    });

    await main([GAME, "--once", "--no-listen", "--db-refresh"]);

    const frame = audit.frames[0]!;
    expect(frame).toContain("DB players refresh: database is locked");
    expect(frame).toContain("Tickets: 3 | Players(DB): 0");
  });

  test("reports a failure to compute the current winner and keeps the join preview", async () => {
    const audit = fakeAuditEnvironment({ polls: [{ slot: 300 }] });
    const oracle = await OracleService.getInstance();
    oracle.completionManager.calculateWinnerIndex = ((_secret: Buffer, slot: number, n: number) => {
      if (n === 2) throw new Error("entropy unavailable");
      return slot % n;
    }) as never;

    await main([GAME, "--once", "--no-listen", "--slots", "1"]);

    const frame = audit.frames[0]!;
    expect(frame).toContain("- Compute winner: entropy unavailable");
    expect(frame).toContain("If 1 new ticket joins at future slot (n=3):");
    expect(frame).toContain("Winner if completes now: n/a");
    expect(frame).toContain(`301 -> index=   1 pos=   2 winner=${PLAYER_B}`);
  });

  test("reports account fetch failures and treats the game as gone", async () => {
    const audit = fakeAuditEnvironment({
      polls: [{ slot: 300, account: new Error("429 from RPC") }],
    });

    await main([GAME, "--no-listen"]);

    const frame = audit.frames[0]!;
    expect(frame).toContain("Fetch game account: 429 from RPC");
    expect(frame).toContain("Status: completed (account missing)");
    expect(audit.delays).toEqual([]);
  });

  test("flags a mismatch between on-chain tickets and the local player registry", async () => {
    const audit = fakeAuditEnvironment({
      polls: [{ slot: 300, account: account({ ticketsCount: 5n }) }],
    });

    await main([GAME, "--once", "--no-listen"]);

    expect(audit.frames[0]).toContain(
      "Player registry mismatch: on-chain ticketsCount=5, DB players=2",
    );
  });

  test("refuses to audit a game without a local secret when given an address", async () => {
    fakeAuditEnvironment({ polls: [] });

    await expect(main([OTHER_GAME, "--once"])).rejects.toThrow(
      `No secret key found in this oracle DB for ${OTHER_GAME} (tracked(status=pending)).`,
    );
  });

  test("prompts for a pending game until one with a local secret is chosen", async () => {
    const output = captureConsole(restorer);
    const audit = fakeAuditEnvironment({
      pending: [
        { game_address: OTHER_GAME, completion_attempts: 1 },
        { game_address: GAME, completion_attempts: 0 },
      ],
      answers: ["1", "2"],
      polls: [{ slot: 200 }],
    });

    await main(["--once", "--no-listen"]);

    expect(audit.questions).toEqual(["Select # or paste address: ", "Select # or paste address: "]);
    expect(audit.screen.join("")).toContain(` 1. ${OTHER_GAME} (attempts=1)`);
    expect(String(output.error[0]?.[0])).toContain(
      `No secret key found in this oracle DB for ${OTHER_GAME}`,
    );
    expect(audit.promptsClosed).toBe(2);
    expect(audit.frames.at(-1)).toContain(`Game: ${GAME}`);
  });

  test("accepts a pasted address when nothing is pending", async () => {
    const audit = fakeAuditEnvironment({ answers: [`  ${GAME}  `], polls: [{ slot: 200 }] });

    await main(["--once", "--no-listen"]);

    expect(audit.questions).toEqual(["Game address (base58): "]);
    expect(audit.frames.at(-1)).toContain(`Game: ${GAME}`);
  });

  test("treats an out-of-range selection as a pasted address", async () => {
    const output = captureConsole(restorer);
    const audit = fakeAuditEnvironment({
      pending: [{ game_address: GAME, completion_attempts: 0 }],
      answers: ["9", "1"],
      polls: [{ slot: 200 }],
    });

    await main(["--once", "--no-listen"]);

    expect(String(output.error[0]?.[0])).toContain(
      "No secret key found in this oracle DB for 9 (not tracked).",
    );
    expect(audit.questions).toHaveLength(2);
    expect(audit.frames.at(-1)).toContain(`Game: ${GAME}`);
  });

  test("fails when the secret disappears before the audit starts", async () => {
    const audit = fakeAuditEnvironment({ polls: [] });
    const db = OracleDatabase.getInstance();
    let lookups = 0;
    db.getSecretKeyInfo = (() => {
      lookups += 1;
      return lookups === 1 ? { secretKey: SECRET, used: false } : null;
    }) as never;

    await expect(main([GAME, "--once", "--no-listen"])).rejects.toThrow(
      `No secret key found in local DB for ${GAME}`,
    );
    expect(lookups).toBe(2);
    expect(audit.frames).toEqual([]);
  });

  test("the CLI reports failures and exits with code 1", async () => {
    const output = captureConsole(restorer);
    const exits: Array<number | undefined> = [];
    restorer.track(
      spyOn(process, "exit").mockImplementation(((code?: number) => {
        exits.push(code);
      }) as never),
    );
    const getInstance = restorer.track(spyOn(OracleService, "getInstance"));

    await runCli(["--bogus"]);

    expect(exits).toEqual([1]);
    expect(output.error).toEqual([["audit-random failed: Unknown argument: --bogus"]]);
    expect(getInstance).not.toHaveBeenCalled();
  });

  test("the CLI reports non-Error failures verbatim", async () => {
    const output = captureConsole(restorer);
    const exits: Array<number | undefined> = [];
    restorer.track(
      spyOn(process, "exit").mockImplementation(((code?: number) => {
        exits.push(code);
      }) as never),
    );
    restorer.track(spyOn(OracleService, "getInstance").mockRejectedValue("rpc offline"));

    await runCli([GAME, "--once"]);

    expect(exits).toEqual([1]);
    expect(output.error).toEqual([["audit-random failed: rpc offline"]]);
  });

  test("the CLI completes without exiting when the audit succeeds", async () => {
    const audit = fakeAuditEnvironment({ polls: [{ slot: 200 }] });
    const exit = restorer.track(spyOn(process, "exit"));

    await runCli([GAME, "--once", "--no-listen"]);

    expect(exit).not.toHaveBeenCalled();
    expect(audit.frames).toHaveLength(1);
    expect(audit.stopped).toBe(1);
  });

  test("rejects an empty answer at the prompt", async () => {
    fakeAuditEnvironment({ answers: [""], polls: [] });

    await expect(main(["--once"])).rejects.toThrow("No game address provided");
  });
});
