interface CachedPrice {
  priceUsd: number;
  expiresAt: number;
}

export interface TokenPriceResolver {
  getTokenUsdPrices(mints: readonly string[]): Promise<Map<string, number>>;
}

type PriceFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const TOKEN_PRICE_CACHE_TTL_MS = 60_000;
const JUPITER_PRICE_URL = "https://api.jup.ag/price/v3";
const JUPITER_MAX_IDS = 50;

function readPositivePrice(entry: unknown): number | null {
  if (!entry || typeof entry !== "object") return null;
  const value = (entry as { usdPrice?: unknown }).usdPrice;
  const priceUsd = typeof value === "number" ? value : Number(value);
  return Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null;
}

export class JupiterTokenPriceResolver implements TokenPriceResolver {
  private readonly cache = new Map<string, CachedPrice>();

  public constructor(
    private readonly apiKey: string | null,
    private readonly fetcher: PriceFetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  public async getTokenUsdPrices(mints: readonly string[]): Promise<Map<string, number>> {
    const requested = [...new Set(mints)].sort();
    const prices = new Map<string, number>();
    const missing: string[] = [];
    const now = this.now();

    for (const mint of requested) {
      const cached = this.cache.get(mint);
      if (cached && cached.expiresAt > now) prices.set(mint, cached.priceUsd);
      else missing.push(mint);
    }
    if (missing.length === 0) return prices;
    if (!this.apiKey) throw new Error("Jupiter API key is unavailable");

    for (let offset = 0; offset < missing.length; offset += JUPITER_MAX_IDS) {
      const chunk = missing.slice(offset, offset + JUPITER_MAX_IDS);
      const url = new URL(JUPITER_PRICE_URL);
      url.searchParams.set("ids", chunk.join(","));
      const response = await this.fetcher(url, {
        headers: { Accept: "application/json", "x-api-key": this.apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Jupiter Price API returned HTTP ${response.status}`);
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Jupiter Price API returned invalid JSON");
      }
      const root = payload as Record<string, unknown>;
      const entries =
        root["data"] && typeof root["data"] === "object" && !Array.isArray(root["data"])
          ? (root["data"] as Record<string, unknown>)
          : root;

      for (const mint of chunk) {
        const priceUsd = readPositivePrice(entries[mint]);
        if (priceUsd === null) throw new Error(`Jupiter did not return a valid price for ${mint}`);
        prices.set(mint, priceUsd);
        this.cache.set(mint, { priceUsd, expiresAt: now + TOKEN_PRICE_CACHE_TTL_MS });
      }
    }

    return prices;
  }
}
