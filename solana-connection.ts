import * as anchor from "@coral-xyz/anchor";

export const MAINNET_FALLBACK_RPC = "https://api.mainnet-beta.solana.com";

type ConnectionFactory = (
  endpoint: string,
  commitment: anchor.web3.Commitment
) => anchor.web3.Connection;

let connectionFactory: ConnectionFactory = (endpoint, commitment) =>
  new anchor.web3.Connection(endpoint, commitment);

function buildConnection(
  endpoint: string,
  commitment: anchor.web3.Commitment
): anchor.web3.Connection {
  return connectionFactory(endpoint, commitment);
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

const NETWORK_ERROR_PATTERNS = [
  "failed to fetch",
  "fetch failed",
  "network error",
  "socket hang up",
  "connect econn",
  "getaddrinfo enotfound",
  "timed out",
];

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

export function isConnectionIssue(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const err = current as NodeJS.ErrnoException & { message?: string; cause?: unknown };
    if (typeof err.code === "string" && NETWORK_ERROR_CODES.has(err.code)) {
      return true;
    }

    if (typeof err.message === "string") {
      const lower = err.message.toLowerCase();
      if (NETWORK_ERROR_PATTERNS.some((pattern) => lower.includes(pattern))) {
        return true;
      }
    }

    current = err.cause;
  }

  if (typeof error === "string") {
    const lower = error.toLowerCase();
    return NETWORK_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    return NETWORK_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
  }

  return false;
}

function createConnectionWithFallback(
  primaryUrl: string,
  fallbackUrl: string,
  commitment: anchor.web3.Commitment
): anchor.web3.Connection {
  const primary = buildConnection(primaryUrl, commitment);
  const fallback = buildConnection(fallbackUrl, commitment);
  let usingFallback = false;
  let loggedFallback = false;

  const logFallback = (error: unknown) => {
    if (loggedFallback) {
      return;
    }
    loggedFallback = true;
    const reason = error instanceof Error ? error.message : String(error ?? "unknown error");
    console.warn(
      `⚠️  Failed to reach configured Solana RPC (${primaryUrl}): ${reason}. Falling back to ${fallbackUrl}.`
    );
  };

  const proxy = new Proxy(primary, {
    get(target, prop, receiver) {
      const active = usingFallback ? fallback : target;

      if (prop === "rpcEndpoint") {
        return (usingFallback ? fallback : target).rpcEndpoint;
      }

      const value = Reflect.get(active, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }

      return (...args: any[]) => {
        const invokeOn = (conn: anchor.web3.Connection) => {
          const fn = Reflect.get(conn, prop, conn) as (...fnArgs: any[]) => any;
          return fn.apply(conn, args);
        };

        if (usingFallback) {
          return invokeOn(fallback);
        }

        try {
          const result = invokeOn(primary);
          if (result instanceof Promise) {
            return result.catch((error: unknown) => {
              if (!usingFallback && isConnectionIssue(error)) {
                usingFallback = true;
                logFallback(error);
                return invokeOn(fallback);
              }
              throw error;
            });
          }
          return result;
        } catch (error) {
          if (!usingFallback && isConnectionIssue(error)) {
            usingFallback = true;
            logFallback(error);
            return invokeOn(fallback);
          }
          throw error;
        }
      };
    },
  });

  return proxy as anchor.web3.Connection;
}

export function createSolanaConnection(
  networkUrl: string,
  commitment: anchor.web3.Commitment = "confirmed"
): anchor.web3.Connection {
  const trimmed = networkUrl.trim();
  const normalizedPrimary = normalizeEndpoint(trimmed);
  const normalizedFallback = normalizeEndpoint(MAINNET_FALLBACK_RPC);

  if (!trimmed) {
    throw new Error("SOLANA_NETWORK environment variable is required");
  }

  if (normalizedPrimary === normalizedFallback) {
    return buildConnection(trimmed, commitment);
  }

  return createConnectionWithFallback(trimmed, MAINNET_FALLBACK_RPC, commitment);
}

export const __testing = {
  setConnectionFactory(factory?: ConnectionFactory) {
    connectionFactory = factory
      ? factory
      : (endpoint, commitment) => new anchor.web3.Connection(endpoint, commitment);
  },
};
