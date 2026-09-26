import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair } from "./helpers/solana-fixtures.ts";
import { getTokenUsdPrices } from "../indexer/pricing.ts";

// The price cache is module-wide, so every test uses mints no other test has seen.
const mint = () => Keypair.generate().publicKey.toBase58();

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init?: RequestInit,
  ) => handler(String(url), init)) as unknown as typeof fetch);
  restores.push(() => spy.mockRestore());
  return spy;
}

describe("getTokenUsdPrices", () => {
  test("returns no prices without an API key and does not call Jupiter", async () => {
    const fetchSpy = mockFetch(() => Response.json({}));

    const prices = await getTokenUsdPrices([mint()], null);

    expect(prices.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("fetches positive prices once and serves repeats from the cache", async () => {
    const priced = mint();
    const unpriced = mint();
    const fetchSpy = mockFetch((url, init) => {
      expect(url).toContain(encodeURIComponent(`${priced},${unpriced}`));
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("secret-key");
      return Response.json({ [priced]: { usdPrice: 1.25 }, [unpriced]: { usdPrice: 0 } });
    });

    const first = await getTokenUsdPrices([priced, unpriced, priced], "secret-key");
    const second = await getTokenUsdPrices([priced, unpriced], "secret-key");

    expect([...first]).toEqual([[priced, 1.25]]);
    expect([...second]).toEqual([[priced, 1.25]]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("refreshes cached prices after they expire", async () => {
    const token = mint();
    let now = 1_800_000_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    restores.push(() => clock.mockRestore());
    let price = 1;
    const fetchSpy = mockFetch(() => Response.json({ [token]: { usdPrice: price } }));

    await getTokenUsdPrices([token], "key");
    price = 2;
    now += 60_001;
    const refreshed = await getTokenUsdPrices([token], "key");

    expect(refreshed.get(token)).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("splits large requests into chunks of fifty and tolerates a failed chunk", async () => {
    const tokens = Array.from({ length: 60 }, mint);
    const fetchSpy = mockFetch((url) => {
      const ids = decodeURIComponent(new URL(url).searchParams.get("ids")!).split(",");
      if (ids.length === 10) return new Response("busy", { status: 503 });
      return Response.json(Object.fromEntries(ids.map((id) => [id, { usdPrice: 3 }])));
    });

    const prices = await getTokenUsdPrices(tokens, "key");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(prices.size).toBe(50);
    expect(prices.get(tokens[0]!)).toBe(3);
    expect(prices.has(tokens[59]!)).toBe(false);
  });

  test("uses the configured Jupiter price URL", async () => {
    const previous = process.env["JUPITER_PRICE_URL"];
    process.env["JUPITER_PRICE_URL"] = "https://prices.example/v9";
    restores.push(() => {
      if (previous === undefined) delete process.env["JUPITER_PRICE_URL"];
      else process.env["JUPITER_PRICE_URL"] = previous;
    });
    const fetchSpy = mockFetch(() => Response.json({}));

    await getTokenUsdPrices([mint()], "key");

    expect(String(fetchSpy.mock.calls[0]![0])).toStartWith("https://prices.example/v9?ids=");
  });
});
