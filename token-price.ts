interface CachedPrice {
  priceUsd: number;
  expiresAt: number;
}

export interface TokenPriceResolver {
  getTokenUsdPrices(
    mints: readonly string[],
    options?: { allowPartial?: boolean },
  ): Promise<Map<string, number>>;
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
  private readonly inFlight = new Map<string, Promise<number | null>>();

  public constructor(
    private readonly apiKey: string | null,
    private readonly fetcher: PriceFetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  public async getTokenUsdPrices(
    mints: readonly string[],
    options: { allowPartial?: boolean } = {},
  ): Promise<Map<string, number>> {
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
    const apiKey = this.apiKey;
    if (!apiKey) throw new Error("Jupiter API key is unavailable");

    const toFetch = missing.filter((mint) => !this.inFlight.has(mint));
    if (toFetch.length > 0) this.startPriceFetch(toFetch, apiKey);

    const resolved = await Promise.all(
      missing.map(async (mint) => [mint, await this.inFlight.get(mint)!] as const),
    );
    for (const [mint, priceUsd] of resolved) {
      if (priceUsd === null) {
        if (!options.allowPartial)
          throw new Error(`Jupiter did not return a valid price for ${mint}`);
        continue;
      }
      prices.set(mint, priceUsd);
    }

    return prices;
  }

  private startPriceFetch(mints: readonly string[], apiKey: string): void {
    const request = this.fetchTokenUsdPrices(mints, apiKey);
    for (const mint of mints) {
      const pending = request.then((prices) => prices.get(mint) ?? null);
      this.inFlight.set(mint, pending);
      void pending
        .finally(() => {
          if (this.inFlight.get(mint) === pending) this.inFlight.delete(mint);
        })
        .catch(() => undefined);
    }
  }

  private async fetchTokenUsdPrices(
    mints: readonly string[],
    apiKey: string,
  ): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    for (let offset = 0; offset < mints.length; offset += JUPITER_MAX_IDS) {
      const chunk = mints.slice(offset, offset + JUPITER_MAX_IDS);
      const url = new URL(JUPITER_PRICE_URL);
      url.searchParams.set("ids", chunk.join(","));
      const response = await this.fetcher(url, {
        headers: { Accept: "application/json", "x-api-key": apiKey },
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
        if (priceUsd === null) continue;
        prices.set(mint, priceUsd);
        this.cache.set(mint, { priceUsd, expiresAt: this.now() + TOKEN_PRICE_CACHE_TTL_MS });
      }
    }
    return prices;
  }
}
