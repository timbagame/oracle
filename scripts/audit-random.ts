import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type * as anchor from "@coral-xyz/anchor";
import type { Connection, PublicKey } from "@solana/web3.js";
import { OracleDatabase } from "../database.ts";
import { OracleService } from "../oracle-service.ts";
import type { Timba } from "../idl/idlType.ts";
import type { TimbaGameAccount, TimbaPlayerEvent } from "../types/timba.ts";
import { ensurePublicKey, resolveNumericLike, toBase58 } from "../solana-utils.ts";

type CliOptions = {
  gameAddress?: string;
  intervalMs: number;
  lookaheadSlots: number;
  once: boolean;
  listen: boolean;
  refreshFromDbEachTick: boolean;
};

type PlayerMutation =
  | { action: "joined"; playerAddress: string; ticketIndex: number }
  | { action: "unjoined"; ticketIndex: number };

function parseArgs(argv: string[]): CliOptions {
  let gameAddress: string | undefined;
  let intervalMs = 1000;
  let lookaheadSlots = 25;
  let once = false;
  let listen = true;
  let refreshFromDbEachTick = true;

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
      case "--no-db-refresh":
        refreshFromDbEachTick = false;
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

function extractPlayerMutation(
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

  const gameAddress = (options.gameAddress?.trim() || (await promptSelectGame(db))).trim();

  const secretData = db.getSecretKey(gameAddress);
  if (!secretData) {
    throw new Error(`No secret key found in local DB for ${gameAddress}`);
  }

  const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");

  const gamePda = ensurePublicKey(gameAddress);

  const connection = (oracle as unknown as { connection: Connection }).connection;
  const program = (oracle as unknown as { program: anchor.Program<Timba> }).program;

  let listenerIds: number[] = [];
  const registerPlayerListeners = async (): Promise<void> => {
    if (!options.listen) return;

    const onEvent = (action: "joined" | "unjoined") => async (event: TimbaPlayerEvent) => {
      const extracted = extractPlayerMutation(action, event);
      if (!extracted) return;
      if (extracted.gameAddress !== gameAddress) return;
      db.applyPlayerMutations(gameAddress, [extracted.mutation]);
    };

    listenerIds = await Promise.all([
      program.addEventListener("playerJoined", onEvent("joined")),
      program.addEventListener("playerUnjoined", onEvent("unjoined")),
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

    const ticketsCount = gameAccount ? Number(gameAccount.ticketsCount) : 0;
    const lastSlot = gameAccount ? Number(gameAccount.lastSlot) : 0;
    const createdAt = gameAccount ? Number(gameAccount.createdAt) : null;
    const timeout = gameAccount ? Number(gameAccount.timeout) : null;
    const expiresAt = createdAt !== null && timeout !== null ? createdAt + timeout : null;

    const winnerText =
      winnerIndexNow === null
        ? "n/a"
        : computeWinnerDisplay({ ticketsCount, players, winnerIndex: winnerIndexNow });

    const lines: string[] = [];
    lines.push(`Game: ${gameAddress}`);
    lines.push(`Slot: ${currentSlot ?? "n/a"} | BlockTime: ${formatUnixSeconds(blockTime ?? undefined)}`);
    lines.push(`Tickets: ${ticketsCount} | Players(DB): ${players.length} | lastSlot(entropy): ${lastSlot}`);
    lines.push(`CreatedAt: ${formatUnixSeconds(createdAt ?? undefined)} | ExpiresAt: ${formatUnixSeconds(expiresAt ?? undefined)}`);
    lines.push(`Winner if completes now: ${winnerText}`);
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

    if (errors.length > 0) {
      lines.push("");
      lines.push("Errors:");
      for (const error of errors) {
        lines.push(`- ${error}`);
      }
    }

    lines.push("");
    lines.push("Ctrl+C to exit.");

    process.stdout.write("\x1Bc");
    process.stdout.write(lines.join("\n"));
    process.stdout.write("\n");
  };

  const pollOnce = async (): Promise<void> => {
    const errors: string[] = [];
    let currentSlot: number | null = null;
    let blockTime: number | null = null;
    let gameAccount: TimbaGameAccount | null = null;

    try {
      currentSlot = await connection.getSlot();
      blockTime = await connection.getBlockTime(currentSlot);
    } catch (error) {
      errors.push(`RPC slot/time: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      gameAccount = await fetchGameAccount(program, gamePda);
    } catch (error) {
      errors.push(`Fetch game account: ${error instanceof Error ? error.message : String(error)}`);
    }

    const players = options.refreshFromDbEachTick ? db.getGamePlayers(gameAddress) : [];

    let winnerIndexNow: number | null = null;
    if (gameAccount && players.length > 0) {
      const ticketsCount = Number(gameAccount.ticketsCount);
      if (Number.isFinite(ticketsCount) && ticketsCount !== players.length) {
        errors.push(`Player registry mismatch: on-chain ticketsCount=${ticketsCount}, DB players=${players.length}`);
      }
      try {
        winnerIndexNow = completion.calculateWinnerIndex(
          secretKeyBuffer,
          Number(gameAccount.lastSlot),
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

    if (gameAccount === null) {
      throw new Error("Game account not found on-chain (it may be completed/closed)");
    }
  };

  try {
    await registerPlayerListeners();
    await pollOnce();
    if (options.once) return;

    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
      await pollOnce();
    }
  } finally {
    await unregisterPlayerListeners().catch(() => {});
    await oracle.stopEventListening().catch(() => {});
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`audit-random failed: ${message}`);
  process.exit(1);
});
