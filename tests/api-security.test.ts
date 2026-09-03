import { describe, expect, test } from "bun:test";
import { createRouteRateLimiter, hasValidBearerToken } from "../api-security.ts";

describe("oracle API security", () => {
  test("validates bearer tokens without accepting malformed credentials", () => {
    expect(hasValidBearerToken("Bearer service-secret", "service-secret")).toBe(true);
    expect(hasValidBearerToken("Bearer wrong", "service-secret")).toBe(false);
    expect(hasValidBearerToken("service-secret", "service-secret")).toBe(false);
    expect(hasValidBearerToken(null, "service-secret")).toBe(false);
  });

  test("limits protected routes and resets the window", () => {
    let now = 1_000;
    const limit = createRouteRateLimiter(() => now);

    for (let index = 0; index < 20; index += 1) {
      expect(limit("/generate-hash").allowed).toBe(true);
    }
    expect(limit("/generate-hash").allowed).toBe(false);

    now += 1_000;
    expect(limit("/generate-hash").allowed).toBe(true);
  });

  test("caps public indexer traffic before it reaches SQLite", () => {
    const limit = createRouteRateLimiter(() => 1_000);

    for (let index = 0; index < 100; index += 1) {
      expect(limit("/indexer/api/player-profile").allowed).toBe(true);
    }
    expect(limit("/indexer/api/player-profile").allowed).toBe(false);
  });
});
