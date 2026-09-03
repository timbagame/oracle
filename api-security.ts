import { timingSafeEqual } from "crypto";

export const MAX_REQUEST_BODY_BYTES = 16 * 1024;

const WINDOW_MS = 1_000;
const INDEXER_ROUTE_LIMIT = 100;
const ROUTE_LIMITS: Readonly<Record<string, number>> = {
  "/generate-hash": 20,
  "/sign-game-transaction": 20,
  "/games/complete-now": 50,
  "/token-policies": 10,
  "/stats": 10,
};

export function hasValidBearerToken(authorization: string | null, expectedToken: string): boolean {
  if (!authorization?.startsWith("Bearer ") || expectedToken.length === 0) {
    return false;
  }

  const provided = Buffer.from(authorization.slice(7), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export function createRouteRateLimiter(
  now: () => number = Date.now,
): (path: string) => RateLimitResult {
  const windows = new Map<string, { startedAt: number; count: number }>();

  return (path: string): RateLimitResult => {
    const limit =
      ROUTE_LIMITS[path] ??
      (path === "/indexer" || path.startsWith("/indexer/") ? INDEXER_ROUTE_LIMIT : undefined);
    if (limit === undefined) return { allowed: true };

    const currentTime = now();
    const current = windows.get(path);
    if (!current || currentTime - current.startedAt >= WINDOW_MS) {
      windows.set(path, { startedAt: currentTime, count: 1 });
      return { allowed: true };
    }

    current.count += 1;
    if (current.count <= limit) return { allowed: true };

    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((WINDOW_MS - (currentTime - current.startedAt)) / 1_000),
      ),
    };
  };
}
