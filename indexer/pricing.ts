import { z } from "zod";

const ResponseSchema = z.record(
  z.string(),
  z.object({ usdPrice: z.number().nullable().optional() }).passthrough(),
);
const MAX_IDS = 50;
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { price: number | null; expiresAt: number }>();

export async function getTokenUsdPrices(
  tokenMints: string[],
  apiKey: string | null,
): Promise<Map<string, number>> {
  const unique = [...new Set(tokenMints)];
  const now = Date.now();
  const prices = new Map<string, number>();
  const missing = unique.filter((mint) => {
    const cached = cache.get(mint);
    if (!cached || cached.expiresAt <= now) return true;
    if (cached.price !== null) prices.set(mint, cached.price);
    return false;
  });
  if (!apiKey || missing.length === 0) return prices;

  const chunks = Array.from({ length: Math.ceil(missing.length / MAX_IDS) }, (_, index) =>
    missing.slice(index * MAX_IDS, (index + 1) * MAX_IDS),
  );
  const responses = await Promise.allSettled(
    chunks.map(async (chunk) => {
      const response = await fetch(
        `https://api.jup.ag/price/v3?ids=${encodeURIComponent(chunk.join(","))}`,
        { headers: { Accept: "application/json", "x-api-key": apiKey } },
      );
      if (!response.ok) throw new Error(`Jupiter returned ${response.status}`);
      return ResponseSchema.parse(await response.json());
    }),
  );
  const returned = Object.assign(
    {},
    ...responses.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
  ) as Record<string, { usdPrice?: number | null }>;
  for (const mint of missing) {
    const candidate = returned[mint]?.usdPrice;
    const price =
      typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
        ? candidate
        : null;
    cache.set(mint, { price, expiresAt: now + CACHE_TTL_MS });
    if (price !== null) prices.set(mint, price);
  }
  return prices;
}
