import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type * as anchor from "@coral-xyz/anchor";
import type { Connection, PublicKey } from "@solana/web3.js";
import { OracleDatabase } from "../database.ts";
import { OracleService } from "../oracle-service.ts";
import type { Timba } from "../idl/idlType.ts";
import type { TimbaGameAccount, TimbaPlayerEvent } from "../types/timba.ts";
import { ensurePublicKey, resolveNumericLike, toBase58, type PublicKeyLike } from "../solana-utils.ts";

export type CliOptions = {
  gameAddress?: string;
  intervalMs: number;
  lookaheadSlots: number;
  once: boolean;
  listen: boolean;
  refreshFromDbEachTick: boolean;
  writeDb: boolean;
  withBlockTime: boolean;
};

export type PlayerMutation =
  | { action: "joined"; playerAddress: string; ticketIndex: number }
  | { action: "unjoined"; ticketIndex: number };

type LastJoinSnapshot = {
  playerAddress: string;
  ticketIndex: number;
  joinedSlot: number | null;
  gameLastSlotAtJoin: number | null;
  observedAtMs: number;
};

export function parseArgs(argv: string[]): CliOptions {
  let gameAddress: string | undefined;
  let intervalMs = 2500;
  let lookaheadSlots = 25;
  let once = false;
  let listen = true;
  let refreshFromDbEachTick = false;
  let writeDb = false;
  let withBlockTime = false;

  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    switch (arg) {
      case "--once":
        once = true;
        continue;
      case "--no-listen":
        listen = false;
        continue;
      case "--db-refresh":
        refreshFromDbEachTick = true;
        continue;
      case "--no-db-refresh":
        refreshFromDbEachTick = false;
        continue;
      case "--write-db":
        writeDb = true;
        continue;
      case "--with-block-time":
        withBlockTime = true;
        continue;
      case "--interval": {
        const value = argv[index + 1];
        if (!value) throw new Error("Missing value for --interval");
        intervalMs = Number(value);
        if (!Number.isFinite(intervalMs) || intervalMs < 100) {
          throw new Error("--interval must be a number >= 100 (ms)");
        }
        index += 1;
        continue;
      }
      case "--slots": {
        const value = argv[index + 1];
        if (!value) throw new Error("Missing value for --slots");
        lookaheadSlots = Number(value);
        if (!Number.isFinite(lookaheadSlots) || lookaheadSlots < 1 || lookaheadSlots > 500) {
          throw new Error("--slots must be a number between 1 and 500");
        }
        index += 1;
        continue;
      }
      case "--game": {
        const value = argv[index + 1];
        if (!value) throw new Error("Missing value for --game");
        gameAddress = value;
        index += 1;
        continue;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!gameAddress && positionals.length > 0) {
    gameAddress = positionals[0];
  }

  return {
    gameAddress,
    intervalMs,
    lookaheadSlots,
    once,
    listen,
    refreshFromDbEachTick,
    writeDb,
    withBlockTime,
  };
}

async function promptSelectGame(db: OracleDatabase): Promise<string> {
  const pending = db.getPendingGames();
  const rl = createInterface({ input, output });

  try {
    if (pending.length === 0) {
      const address = (await rl.question("Game address (base58): ")).trim();
      if (!address) throw new Error("No game address provided");
      return address;
    }

    output.write("Pending games:\n");
    pending.forEach((row, idx) => {
      output.write(`${String(idx + 1).padStart(2, " ")}. ${row.game_address} (attempts=${row.completion_attempts})\n`);
    });
    const response = (await rl.question("Select # or paste address: ")).trim();

    const numeric = Number(response);
    if (Number.isFinite(numeric) && Number.isInteger(numeric) && numeric >= 1 && numeric <= pending.length) {
      const picked = pending[numeric - 1];
      if (!picked) throw new Error("Invalid selection");
      return picked.game_address;
    }

    if (!response) throw new Error("No game address provided");
    return response;
  } finally {
    rl.close();
  }
}

export function extractPlayerMutation(
  action: "joined" | "unjoined",
  event: TimbaPlayerEvent,
): { gameAddress: string; mutation: PlayerMutation } | null {
  const legacyGameKey = (event as Record<string, unknown>)["game_key"];
  const rawGameKey =
    event.gameAddress ??
    event.gameKey ??
    event.game ??
    (typeof legacyGameKey === "string" ? legacyGameKey : undefined);
  const gameAddress = rawGameKey ? toBase58(rawGameKey) : undefined;

  if (!gameAddress) {
    return null;
  }

  const ticketIndex = resolveNumericLike(event.ticketIndex ?? event.ticket_index);
  if (ticketIndex === undefined || ticketIndex < 0) {
    return null;
  }

  if (action === "unjoined") {
    return { gameAddress, mutation: { action: "unjoined", ticketIndex } };
  }

  const legacyPlayerKey = (event as Record<string, unknown>)["player_address"];
  const rawPlayerKey =
    event.playerAddress ??
    event.player ??
    (typeof legacyPlayerKey === "string" ? legacyPlayerKey : undefined);
  const playerAddress = rawPlayerKey ? toBase58(rawPlayerKey) : undefined;
  if (!playerAddress) {
    return null;
  }

  return { gameAddress, mutation: { action: "joined", playerAddress, ticketIndex } };
}

export function extractGameAddressFromEventPayload(event: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    event["gameAddress"],
    event["gameKey"],
    event["game"],
    event["game_key"],
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = toBase58(candidate as PublicKeyLike);
    if (normalized) return normalized;
  }

  return null;
}

export function applyMutationToPlayersCache(
  playersCache: (string | undefined)[],
  mutation: PlayerMutation,
): void {
  if (mutation.action === "joined") {
    playersCache[mutation.ticketIndex] = mutation.playerAddress;
    return;
  }
  playersCache[mutation.ticketIndex] = undefined;
}

export function materializePlayersCache(playersCache: (string | undefined)[]): string[] {
  return playersCache.filter((player): player is string => typeof player === "string");
}

async function fetchGameAccount(
  program: anchor.Program<Timba>,
  gamePda: PublicKey,
): Promise<TimbaGameAccount | null> {
  try {
    return (await program.account.game.fetch(gamePda)) as TimbaGameAccount;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Account does not exist")) {
      return null;
    }
    throw error;
  }
}

function formatUnixSeconds(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "n/a";
  const date = new Date(seconds * 1000);
  return date.toISOString();
}

function computeWinnerDisplay(args: {
  ticketsCount: number;
  players: string[];
  winnerIndex: number;
}): string {
  const { ticketsCount, players, winnerIndex } = args;
  if (ticketsCount <= 0 || players.length === 0) return "n/a (no players)";
  const winner = players[winnerIndex];
  if (!winner) return `index=${winnerIndex} (missing player)`;
  return `${winner} (index=${winnerIndex}, position=${winnerIndex + 1})`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const oracle = OracleService.getInstance();
  const completion = oracle.completionManager;
  const db = OracleDatabase.getInstance();

  const isInteractive = !options.gameAddress;
  let gameAddress = (options.gameAddress?.trim() || "").trim();
  for (;;) {
    if (!gameAddress) {
      gameAddress = (await promptSelectGame(db)).trim();
    }

    const secretInfo = db.getSecretKeyInfo(gameAddress);
    if (secretInfo) {
      break;
    }

    const status = db.getGameStatus(gameAddress);
    const tracked = status ? `tracked(status=${status})` : "not tracked";
    const hint = [
      `No secret key found in this oracle DB for ${gameAddress} (${tracked}).`,
      "This tool can only audit games that were created by this oracle instance (/generate-hash), because it needs the secret key.",
      "Pick one of the listed pending games, or paste an address that appears in this oracle.sqlite.",
    ].join("\n");

    if (!isInteractive) {
      throw new Error(hint);
    }

    console.error(hint);
    gameAddress = "";
  }

  let lastJoin: LastJoinSnapshot | null = null;
  let completionStatus: "completed" | "closed" | "missing" | null = null;
  let completionObservedAtMs: number | null = null;
  let completionSlot: number | null = null;

  const secretData = db.getSecretKeyInfo(gameAddress);
  if (!secretData) {
    throw new Error(`No secret key found in local DB for ${gameAddress}`);
  }
  if (secretData.used) {
    // Still usable for audits; mark as finalized context in the UI if we later see the on-chain account missing.
    completionStatus = completionStatus ?? "completed";
  }

  const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");

  const gamePda = ensurePublicKey(gameAddress);

  const connection = (oracle as unknown as { connection: Connection }).connection;
  const program = (oracle as unknown as { program: anchor.Program<Timba> }).program;

  // Keep a local in-memory registry snapshot to avoid writing to SQLite from this script by default.
  let playersCache: (string | undefined)[] = [];
  let lastKnownGameAccount: TimbaGameAccount | null = null;
  try {
    const initialPlayers = db.getGamePlayers(gameAddress);
    playersCache = initialPlayers.slice();
  } catch {
    playersCache = [];
  }

  let listenerIds: number[] = [];
  const registerPlayerListeners = async (): Promise<void> => {
    if (!options.listen) return;

    const onEvent = (action: "joined" | "unjoined") =>
      async (event: TimbaPlayerEvent, slot?: number) => {
      const extracted = extractPlayerMutation(action, event);
      if (!extracted) return;
      if (extracted.gameAddress !== gameAddress) return;
      if (extracted.mutation.action === "joined") {
        const joinedSlot = Number.isFinite(slot) ? (slot as number) : null;
        lastJoin = {
          playerAddress: extracted.mutation.playerAddress,
          ticketIndex: extracted.mutation.ticketIndex,
          joinedSlot,
          gameLastSlotAtJoin: lastKnownGameAccount ? Number(lastKnownGameAccount.lastSlot) : null,
          observedAtMs: Date.now(),
        };
      }
      applyMutationToPlayersCache(playersCache, extracted.mutation);
      if (options.writeDb) {
        db.applyPlayerMutations(gameAddress, [extracted.mutation]);
      }
    };

    const onStatus = (status: "completed" | "closed") =>
      async (event: unknown, slot?: number) => {
      if (!event || typeof event !== "object") return;
      const address = extractGameAddressFromEventPayload(event as Record<string, unknown>);
      if (!address || address !== gameAddress) return;
      completionStatus = status;
      completionObservedAtMs = Date.now();
      completionSlot = Number.isFinite(slot) ? (slot as number) : completionSlot;
    };

    listenerIds = await Promise.all([
      program.addEventListener("playerJoined", onEvent("joined")),
      program.addEventListener("playerUnjoined", onEvent("unjoined")),
      program.addEventListener("gameCompleted", onStatus("completed")),
      program.addEventListener("gameClosed", onStatus("closed")),
    ]);
  };

  const unregisterPlayerListeners = async (): Promise<void> => {
    if (!listenerIds.length) return;
    await Promise.allSettled(listenerIds.map((id) => program.removeEventListener(id)));
    listenerIds = [];
  };

  const render = (payload: {
    currentSlot: number | null;
    blockTime: number | null;
    gameAccount: TimbaGameAccount | null;
    players: string[];
    winnerIndexNow: number | null;
    errors: string[];
  }) => {
    const { currentSlot, blockTime, gameAccount, players, winnerIndexNow, errors } = payload;

    const displayAccount = gameAccount ?? lastKnownGameAccount;

    const ticketsCount = displayAccount ? Number(displayAccount.ticketsCount) : 0;
    const lastSlot = displayAccount ? Number(displayAccount.lastSlot) : 0;
    const createdAt = displayAccount ? Number(displayAccount.createdAt) : null;
    const timeout = displayAccount ? Number(displayAccount.timeout) : null;
    const expiresAt = createdAt !== null && timeout !== null ? createdAt + timeout : null;

    const isFinal =
      completionStatus === "completed" ||
      completionStatus === "closed" ||
      completionStatus === "missing";

    const statusLine = (() => {
      if (completionStatus === "completed") return "completed";
      if (completionStatus === "closed") return "closed";
      if (completionStatus === "missing") return "completed (account missing)";
      return "active";
    })();

    const lastJoinLine = lastJoin
      ? `${lastJoin.playerAddress} (ticketIndex=${lastJoin.ticketIndex}, joinedSlot=${lastJoin.joinedSlot ?? "n/a"}, gameLastSlotAtJoin=${lastJoin.gameLastSlotAtJoin ?? "n/a"}, at=${new Date(lastJoin.observedAtMs).toISOString()})`
      : "n/a";

    const winnerText =
      winnerIndexNow === null
        ? "n/a"
        : computeWinnerDisplay({ ticketsCount, players, winnerIndex: winnerIndexNow });

    const lines: string[] = [];
    lines.push(`Game: ${gameAddress}`);
    lines.push(
      `Status: ${statusLine}${
        completionObservedAtMs ? ` | CompletedAt: ${new Date(completionObservedAtMs).toISOString()}` : ""
      }${
        completionSlot !== null ? ` | CompletedSlot: ${completionSlot}` : ""
      }`,
    );
    lines.push(`Last joiner: ${lastJoinLine}`);
    lines.push(`Slot: ${currentSlot ?? "n/a"} | BlockTime: ${formatUnixSeconds(blockTime ?? undefined)}`);
    lines.push(`Tickets: ${ticketsCount} | Players(DB): ${players.length} | lastSlot(entropy): ${lastSlot}`);
    lines.push(`CreatedAt: ${formatUnixSeconds(createdAt ?? undefined)} | ExpiresAt: ${formatUnixSeconds(expiresAt ?? undefined)}`);
    lines.push(`Winner if completes now: ${winnerText}`);
    if (!isFinal) {
      lines.push("");
      lines.push(`If 1 new ticket joins at future slot (n=${players.length + 1}):`);

      if (currentSlot !== null && players.length >= 0) {
        const joinNPlayers = players.length + 1;
        for (let offset = 1; offset <= options.lookaheadSlots; offset += 1) {
          const slot = currentSlot + offset;
          const winnerIndexIfJoin = completion.calculateWinnerIndex(secretKeyBuffer, slot, joinNPlayers);
          const winnerLabel =
            winnerIndexIfJoin === players.length
              ? "<new join>"
              : (players[winnerIndexIfJoin] ?? "<missing>");
          lines.push(
            `${String(slot).padStart(12, " ")} -> index=${String(winnerIndexIfJoin).padStart(4, " ")} pos=${String(winnerIndexIfJoin + 1).padStart(4, " ")} winner=${winnerLabel}`,
          );
        }
      } else {
        lines.push("n/a (slot unavailable)");
      }
    }

    if (errors.length > 0) {
      lines.push("");
      lines.push("Errors:");
      for (const error of errors) {
        lines.push(`- ${error}`);
      }
    }

    lines.push("");
    lines.push(isFinal ? "Completed. Exiting..." : "Ctrl+C to exit.");

    process.stdout.write("\x1Bc");
    process.stdout.write(lines.join("\n"));
    process.stdout.write("\n");
  };

  const pollOnce = async (): Promise<{ sawRateLimit: boolean }> => {
    const errors: string[] = [];
    let currentSlot: number | null = null;
    let blockTime: number | null = null;
    let gameAccount: TimbaGameAccount | null = null;
    let sawRateLimit = false;

    try {
      currentSlot = await connection.getSlot();
      if (options.withBlockTime) {
        blockTime = await connection.getBlockTime(currentSlot);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("429")) {
        sawRateLimit = true;
      }
      errors.push(`RPC slot/time: ${message}`);
    }

    try {
      gameAccount = await fetchGameAccount(program, gamePda);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("429")) {
        sawRateLimit = true;
      }
      errors.push(`Fetch game account: ${message}`);
    }

    if (gameAccount === null) {
      completionStatus = completionStatus ?? "missing";
      completionObservedAtMs = completionObservedAtMs ?? Date.now();
    }
    if (gameAccount) {
      lastKnownGameAccount = gameAccount;
    }

    let players: string[] = [];
    if (options.refreshFromDbEachTick) {
      try {
        players = db.getGamePlayers(gameAddress);
        playersCache = players.slice();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`DB players refresh: ${message}`);
      }
    } else {
      players = materializePlayersCache(playersCache);
    }

    let winnerIndexNow: number | null = null;
    if (gameAccount && players.length > 0) {
      const ticketsCount = Number(gameAccount.ticketsCount);
      if (Number.isFinite(ticketsCount) && ticketsCount !== players.length) {
        errors.push(`Player registry mismatch: on-chain ticketsCount=${ticketsCount}, DB players=${players.length}`);
      }
    }

    const entropySlot = gameAccount
      ? Number(gameAccount.lastSlot)
      : (lastKnownGameAccount ? Number(lastKnownGameAccount.lastSlot) : null);

    if (entropySlot !== null && Number.isFinite(entropySlot) && players.length > 0) {
      try {
        winnerIndexNow = completion.calculateWinnerIndex(
          secretKeyBuffer,
          entropySlot,
          players.length,
        );
      } catch (error) {
        errors.push(`Compute winner: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    render({
      currentSlot,
      blockTime: blockTime ?? null,
      gameAccount,
      players,
      winnerIndexNow,
      errors,
    });

    return { sawRateLimit };
  };

  try {
    await registerPlayerListeners();
    await pollOnce();
    if (options.once) return;
    if (completionStatus) return;

    let delayMs = options.intervalMs;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const { sawRateLimit } = await pollOnce();
      if (sawRateLimit) {
        delayMs = Math.min(30_000, Math.max(2_000, delayMs * 2));
      } else {
        delayMs = options.intervalMs;
      }
      if (completionStatus) return;
    }
  } finally {
    await unregisterPlayerListeners().catch(() => {});
    await oracle.stopEventListening().catch(() => {});
  }
}

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`audit-random failed: ${message}`);
    process.exit(1);
  });
}
