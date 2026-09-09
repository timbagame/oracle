import { timbaAbi } from "@timbagame/protocol/evm/v0.1.0";
import { hasValidBearerToken, MAX_REQUEST_BODY_BYTES } from "../api-security.ts";
import { json } from "./store.ts";
import type { EvmService } from "./service.ts";

export function createEvmRouter(service: EvmService, apiToken: string) {
  let window = 0;
  let requests = 0;
  const reply = (body: unknown, status = 200) =>
    new Response(json(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  const route = async (request: Request): Promise<Response> => {
    if (!hasValidBearerToken(request.headers.get("authorization"), apiToken))
      return reply({ error: "Unauthorized" }, 401);
    const now = Math.floor(Date.now() / 1000);
    if (window !== now) {
      window = now;
      requests = 0;
    }
    if (++requests > 30) return reply({ error: "Too many requests" }, 429);
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/evm/config") {
      const { chainId, address, version, tokens, confirmations } = service.config;
      const limits = await service.publicClient.readContract({
        address,
        abi: timbaAbi,
        functionName: "config",
      });
      return reply({ chainId, address, version, tokens, confirmations, buffer: limits[1] });
    }
    if (request.method === "GET" && path === "/evm/health") {
      const healthy =
        !service.lastCycleFailed &&
        Date.now() - service.lastCycleAt < Math.max(30_000, service.config.pollMs * 3);
      return reply(
        {
          status: healthy ? "healthy" : "degraded",
          lastCycleAt: service.lastCycleAt,
          pendingTransaction: service.store.pending()?.hash ?? null,
        },
        healthy ? 200 : 503,
      );
    }
    if (request.method === "GET" && path === "/evm/events")
      return reply({ events: service.store.events() });
    if (request.method === "GET" && path === "/evm/games") {
      const query = new URL(request.url).searchParams;
      const offsetText = query.get("offset") ?? "0";
      const player = query.get("player") ?? undefined;
      if (
        !/^(0|[1-9][0-9]{0,6})$/.test(offsetText) ||
        (player && !/^0x[0-9a-fA-F]{40}$/.test(player))
      )
        return reply({ error: "Invalid query" }, 400);
      const offset = Number(offsetText);
      const ids = service.store.listedGameIds(offset, player);
      const games = await Promise.all(
        ids.slice(0, 20).map(async (id) => ({
          id,
          game: await service.game(id),
          events: service.store.events(id),
        })),
      );
      return reply({ games, nextOffset: ids.length > 20 ? offset + 20 : null });
    }
    const game = /^\/evm\/games\/(0x[0-9a-fA-F]{64})$/.exec(path);
    if (request.method === "GET" && game)
      return reply({
        game: await service.game(game[1] as `0x${string}`),
        events: service.store.events(game[1]),
      });
    if (request.method !== "POST" || !["/evm/authorize", "/evm/private-join"].includes(path))
      return reply({ error: "Not found" }, 404);
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: "Body required" }, 400);
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_REQUEST_BODY_BYTES) {
          await reader.cancel();
          return reply({ error: "Body too large" }, 413);
        }
        chunks.push(value);
      }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return reply(
        path === "/evm/authorize"
          ? await service.authorize(input)
          : await service.privateJoin(input),
      );
    } catch {
      // Never serialize RPC errors, signed transaction payloads, credentials, or secrets.
      return reply(
        { error: "Authorization rejected. Check wallet, nonce, invitation and game terms." },
        400,
      );
    } finally {
      reader.releaseLock();
    }
  };
  return (request: Request) =>
    route(request).catch(() => reply({ error: "EVM service temporarily unavailable" }, 503));
}
