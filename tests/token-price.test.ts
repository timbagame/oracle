import { describe, expect, test } from "bun:test";
import { JupiterTokenPriceResolver, TOKEN_PRICE_CACHE_TTL_MS } from "../token-price.ts";

const MINT = "So11111111111111111111111111111111111111112";
const OTHER_MINT = "11111111111111111111111111111111";

describe("Jupiter token prices", () => {
  test("authenticates, validates, and caches Price V3 responses", async () => {
    let now = 1_000;
    const requests: Array<{ url: string; key: string | null }> = [];
    const resolver = new JupiterTokenPriceResolver(
      "secret",
      async (input, init) => {
        requests.push({
          url: input.toString(),
          key: new Headers(init?.headers).get("x-api-key"),
        });
        return Response.json({ [MINT]: { usdPrice: "123.45" } });
      },
      () => now,
    );

    expect((await resolver.getTokenUsdPrices([MINT])).get(MINT)).toBe(123.45);
    expect((await resolver.getTokenUsdPrices([MINT])).get(MINT)).toBe(123.45);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/price/v3?ids=");
    expect(requests[0]?.key).toBe("secret");

    now += TOKEN_PRICE_CACHE_TTL_MS;
    await resolver.getTokenUsdPrices([MINT]);
    expect(requests).toHaveLength(2);
  });

  test("fails closed for missing credentials, HTTP errors, and invalid prices", async () => {
    await expect(new JupiterTokenPriceResolver(null).getTokenUsdPrices([MINT])).rejects.toThrow(
      "Jupiter API key is unavailable",
    );
    await expect(
      new JupiterTokenPriceResolver(
        "secret",
        async () => new Response("no", { status: 503 }),
      ).getTokenUsdPrices([MINT]),
    ).rejects.toThrow("HTTP 503");
    await expect(
      new JupiterTokenPriceResolver("secret", async () =>
        Response.json({ [MINT]: {} }),
      ).getTokenUsdPrices([MINT]),
    ).rejects.toThrow("did not return a valid price");
  });

  test("can return the valid subset of a price batch", async () => {
    const resolver = new JupiterTokenPriceResolver("secret", async () =>
      Response.json({ [MINT]: { usdPrice: 2 } }),
    );

    const prices = await resolver.getTokenUsdPrices([MINT, OTHER_MINT], {
      allowPartial: true,
    });

    expect(prices).toEqual(new Map([[MINT, 2]]));
  });

  test("coalesces concurrent cache misses and clears failed requests", async () => {
    let requests = 0;
    let fail = true;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolver = new JupiterTokenPriceResolver("secret", async () => {
      requests += 1;
      await gate;
      if (fail) throw new Error("temporary failure");
      return Response.json({ [MINT]: { usdPrice: 3 } });
    });

    const first = resolver.getTokenUsdPrices([MINT]);
    const second = resolver.getTokenUsdPrices([MINT]);
    expect(requests).toBe(1);
    release?.();
    await expect(Promise.all([first, second])).rejects.toThrow("temporary failure");

    fail = false;
    expect((await resolver.getTokenUsdPrices([MINT])).get(MINT)).toBe(3);
    expect(requests).toBe(2);
  });
});
