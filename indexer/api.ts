import { z } from "zod";
import {
  GameByKeyQuerySchema,
  GamesQuerySchema,
  IndexerActiveGamesResponseSchema,
  IndexerGameSchema,
  IndexerGamesResponseSchema,
  IndexerHealthResponseSchema,
  IndexerLeaderboardResponseSchema,
  IndexerPlayerGamesResponseSchema,
  IndexerPlayerProfileSchema,
  IndexerStatsResponseSchema,
  IndexerTokensResponseSchema,
  PlayerQuerySchema,
  indexerContract,
} from "@timbagame/protocol/indexer";
import { logger } from "../logger.ts";
import type { IndexerDatabase } from "./database.ts";
import { getTokenUsdPrices } from "./pricing.ts";
import type { ActiveGameRow, LifecycleRow, PlayerHistoryRow } from "./types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

// Backward-compatible extension of the protocol leaderboard query: older
// clients omit `period` and keep receiving the all-time ranking.
export const LeaderboardQuerySchema = indexerContract.leaderboard.query.extend({
  period: z.enum(["24h", "7d", "all"]).default("all"),
});

function json(
  schema: { parse(value: unknown): unknown },
  value: unknown,
  cache?: string,
): Response {
  return new Response(JSON.stringify(schema.parse(value)), {
    headers: { ...JSON_HEADERS, ...(cache ? { "Cache-Control": cache } : {}) },
  });
}

function error(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}

function parseQuery<T>(schema: z.ZodType<T>, request: Request): T | Response {
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  return parsed.success ? parsed.data : error("Invalid query parameters", 400);
}

function serializeLifecycle(game: LifecycleRow | PlayerHistoryRow) {
  return {
    signature: game.signature,
    gameKey: game.game_key,
    status: game.status,
    creator: game.creator,
    gameType: game.game_type,
    ticketAmount: game.ticket_amount,
    totalAmount: game.total_amount,
    maxTickets: game.max_tickets,
    minTickets: game.min_tickets,
    isPrivate: game.is_private == null ? null : game.is_private === 1,
    createdAt: game.created_at,
    timeout: game.timeout,
    expiresAt:
      game.created_at == null || game.timeout == null ? null : game.created_at + game.timeout,
    winner: game.winner,
    winnerAmount: game.winner_amount,
    feeAmount: game.fee_amount,
    ticketsCount: game.tickets_count,
    tokenMint: game.token_mint,
    timestamp: game.timestamp,
    slot: game.slot,
  };
}

async function addPrices<T extends { tokenMint: string }>(
  values: T[],
  apiKey: string | null,
): Promise<Array<T & { priceUsd: number | null }>> {
  const prices = await getTokenUsdPrices(
    values.map((value) => value.tokenMint),
    apiKey,
  );
  return values.map((value) => ({ ...value, priceUsd: prices.get(value.tokenMint) ?? null }));
}

function serializeActive(game: ActiveGameRow, now: number) {
  return {
    ...game,
    expiresAt: game.created_at + game.timeout,
    timeLeft: Math.max(0, game.created_at + game.timeout - now),
    isPrivate: game.is_private === 1,
  };
}

export function createIndexerApi(database: IndexerDatabase, jupiterApiKey: string | null) {
  return async function handleIndexerRequest(request: Request): Promise<Response> {
    if (request.method !== "GET") return error("Method not allowed", 405);
    const url = new URL(request.url);
    const path = url.pathname.slice("/indexer".length) || "/";
    try {
      if (path === "/health") {
        return json(IndexerHealthResponseSchema, { status: "ok", timestamp: Date.now() });
      }
      if (path === "/api/stats") {
        const query = parseQuery(indexerContract.stats.query, request);
        if (query instanceof Response) return query;
        const stats = database.getStats(query.tokenMint);
        const prices = await getTokenUsdPrices(
          stats.financials.map((item) => item.tokenMint),
          jupiterApiKey,
        );
        return json(
          IndexerStatsResponseSchema,
          {
            ...stats,
            financials: stats.financials.map((item) => ({
              ...item,
              priceUsd: prices.get(item.tokenMint) ?? null,
            })),
          },
          "public, max-age=10",
        );
      }
      if (path === "/api/games") {
        const query = parseQuery(GamesQuerySchema, request);
        if (query instanceof Response) return query;
        const result = database.getGames(query.limit, query.offset, query.tokenMint);
        const games = await addPrices(
          result.games.map((game) => ({
            signature: String(game["signature"]),
            gameKey: String(game["game_key"]),
            winner: String(game["winner"]),
            winnerAmount: Number(game["winner_amount"]),
            feeAmount: Number(game["fee_amount"]),
            ticketsCount: Number(game["tickets_count"]),
            tokenMint: String(game["token_mint"]),
            timestamp: Number(game["timestamp"]),
            slot: Number(game["slot"]),
          })),
          jupiterApiKey,
        );
        return json(
          IndexerGamesResponseSchema,
          {
            games,
            total: result.total,
            page: Math.floor(query.offset / query.limit) + 1,
            limit: query.limit,
          },
          "public, max-age=5",
        );
      }
      if (path === "/api/games/latest") {
        const query = parseQuery(indexerContract.latestGames.query, request);
        if (query instanceof Response) return query;
        const games =
          query.includeLifecycle === "1"
            ? database
                .getLifecycle(query.limit, query.tokenMint, query.gameType)
                .map(serializeLifecycle)
            : database.getGames(query.limit, 0, query.tokenMint).games.map((game) => ({
                signature: String(game["signature"]),
                gameKey: String(game["game_key"]),
                status: "completed" as const,
                creator: null,
                gameType: null,
                ticketAmount: null,
                totalAmount: null,
                maxTickets: null,
                minTickets: null,
                isPrivate: null,
                createdAt: null,
                timeout: null,
                expiresAt: null,
                winner: String(game["winner"]),
                winnerAmount: Number(game["winner_amount"]),
                feeAmount: Number(game["fee_amount"]),
                ticketsCount: Number(game["tickets_count"]),
                tokenMint: String(game["token_mint"]),
                timestamp: Number(game["timestamp"]),
                slot: Number(game["slot"]),
              }));
        return json(
          z.array(IndexerGameSchema),
          await addPrices(games, jupiterApiKey),
          "public, max-age=5",
        );
      }
      if (path === "/api/games/by-key") {
        const query = parseQuery(GameByKeyQuerySchema, request);
        if (query instanceof Response) return query;
        const game = database.getGame(query.gameKey);
        if (!game) return error("Game not found", 404);
        const [priced] = await addPrices([serializeLifecycle(game)], jupiterApiKey);
        return json(IndexerGameSchema, priced, "public, max-age=2, stale-while-revalidate=2");
      }
      if (path === "/api/leaderboard") {
        const query = parseQuery(LeaderboardQuerySchema, request);
        if (query instanceof Response) return query;
        const players = database.getLeaderboard(query.limit, query.tokenMint, query.period);
        return json(
          IndexerLeaderboardResponseSchema,
          { players, count: players.length },
          "public, max-age=30",
        );
      }
      if (path === "/api/tokens") {
        const tokens = database.getTokens().map((token) => ({
          tokenMint: String(token["tokenMint"]),
          games: Number(token["games"]),
          latestTimestamp: Number(token["latestTimestamp"]),
        }));
        return json(
          IndexerTokensResponseSchema,
          { tokens: await addPrices(tokens, jupiterApiKey) },
          "public, max-age=30",
        );
      }
      if (path === "/api/active-games" || path === "/api/my-active-games") {
        let player: string | undefined;
        if (path === "/api/my-active-games") {
          const query = parseQuery(indexerContract.playerActiveGames.query, request);
          if (query instanceof Response) return query;
          player = query.player;
        }
        const now = Math.floor(Date.now() / 1000);
        const games = database
          .getActiveGames(player)
          .filter((game) => game.created_at + game.timeout > now)
          .map((game) => serializeActive(game, now));
        const priced = await addPrices(
          games.map((game) => ({ ...game, tokenMint: game.token_mint })),
          jupiterApiKey,
        );
        const responseGames = priced.map(({ tokenMint: _tokenMint, ...game }) => game);
        return json(
          IndexerActiveGamesResponseSchema,
          { games: responseGames, count: responseGames.length },
          "public, max-age=5, stale-while-revalidate=10",
        );
      }
      if (path === "/api/player-games") {
        const query = parseQuery(PlayerQuerySchema, request);
        if (query instanceof Response) return query;
        const games = database.getPlayerGames(query.player, query.limit, query.offset);
        const priced = await addPrices(
          games.map((game) => ({
            ...serializeLifecycle(game),
            isCreator: game.is_creator === 1,
            isPlayer: game.is_player === 1,
            isJoined: game.is_joined === 1,
          })),
          jupiterApiKey,
        );
        return json(
          IndexerPlayerGamesResponseSchema,
          { games: priced, count: priced.length, limit: query.limit, offset: query.offset },
          "public, max-age=5, stale-while-revalidate=10",
        );
      }
      if (path === "/api/player-profile") {
        const query = parseQuery(indexerContract.playerProfile.query, request);
        if (query instanceof Response) return query;
        const profile = database.getPlayerProfile(query.player);
        const tokens = profile.tokens.map((token) => ({
          tokenMint: String(token["token_mint"]),
          gamesPlayed: Number(token["games_played"]),
          stakedAmount: Number(token["staked_amount"]),
          wonAmount: Number(token["won_amount"]),
        }));
        return json(
          IndexerPlayerProfileSchema,
          {
            wallet: query.player,
            summary: {
              relatedGames: Number(profile.summary["related_games"]),
              createdGames: Number(profile.summary["created_games"]),
              playedGames: Number(profile.summary["played_games"]),
              activeGames: Number(profile.summary["active_games"]),
              completedGames: Number(profile.summary["completed_games"]),
              cancelledGames: Number(profile.summary["cancelled_games"]),
              wins: Number(profile.summary["wins"]),
              losses: Number(profile.summary["losses"]),
              lastActivity:
                profile.summary["last_activity"] == null
                  ? null
                  : Number(profile.summary["last_activity"]),
            },
            tokens: await addPrices(tokens, jupiterApiKey),
            frequentPlayers: profile.frequentPlayers.map((item) => ({
              player: String(item["player"]),
              gamesTogether: Number(item["games_together"]),
            })),
            historyComplete: profile.historyComplete,
          },
          "public, max-age=30, stale-while-revalidate=60",
        );
      }
      return error("Endpoint not found", 404);
    } catch (caught) {
      logger.failure(`Indexer API failed for ${path}:`, caught);
      return error("Internal server error", 500);
    }
  };
}
