import * as anchor from "@coral-xyz/anchor";
import type { Commitment } from "@solana/web3.js";

type Connection = anchor.web3.Connection;

export type RpcEndpointLogger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export interface RpcEndpointManagerOptions {
  commitment?: Commitment;
  logger?: RpcEndpointLogger;
  connectionFactory?: (endpoint: string, commitment: Commitment) => Connection;
}

export interface ActiveEndpointChange {
  endpoint: string;
  index: number;
  previousEndpoint: string;
  previousIndex: number;
}

type ActiveEndpointChangeListener = (
  change: ActiveEndpointChange,
) => void | Promise<void>;

export const DEFAULT_MAINNET_ENDPOINT = "https://api.mainnet-beta.solana.com";
const DEFAULT_COMMITMENT: Commitment = "confirmed";
const TRANSIENT_ERROR_TOKENS = [
  "429",
  "502",
  "503",
  "504",
  "bad gateway",
  "gateway timeout",
  "timeout",
  "timed out",
  "network request failed",
  "failed to fetch",
  "socket hang up",
  "connection refused",
  "connection reset",
  "econnreset",
  "econnrefused",
  "temporarily unavailable",
  "tls",
];

function isRetryableRpcError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const code = (error as { code?: string | number }).code;
  if (typeof code === "string") {
    const normalized = code.toLowerCase();
    if (normalized.startsWith("ecconn") || normalized.startsWith("etimedout")) {
      return true;
    }
  }
  if (typeof code === "number" && code >= 500) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return TRANSIENT_ERROR_TOKENS.some((token) => normalized.includes(token));
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  if (value === null) {
    return false;
  }

  const type = typeof value;
  if (type !== "object" && type !== "function") {
    return false;
  }

  return typeof (value as { then?: unknown }).then === "function";
}

export class RpcEndpointManager {
  private readonly endpoints: string[];
  private readonly commitment: Commitment;
  private readonly logger?: RpcEndpointLogger;
  private readonly connectionFactory: (endpoint: string, commitment: Commitment) => Connection;
  private readonly connectionCache = new Map<number, Connection>();
  private readonly proxyConnection: Connection;
  private activeIndex = 0;
  private readonly endpointChangeListeners = new Set<ActiveEndpointChangeListener>();

  constructor(endpointsInput: readonly string[], options: RpcEndpointManagerOptions = {}) {
    const endpoints = Array.isArray(endpointsInput) ? Array.from(endpointsInput) : [];
    if (endpoints.length === 0) {
      throw new Error("At least one RPC endpoint is required");
    }

    this.endpoints = Array.from(new Set(endpoints.map((url) => url.trim()))).filter(
      (url) => url.length > 0,
    );

    if (this.endpoints.length === 0) {
      throw new Error("SOLANA_NETWORK did not resolve to any RPC endpoints");
    }

    this.commitment = options.commitment ?? DEFAULT_COMMITMENT;
    this.logger = options.logger;
    this.connectionFactory =
      options.connectionFactory ??
      ((endpoint: string, commitment: Commitment) => new anchor.web3.Connection(endpoint, commitment));
    this.proxyConnection = this.createProxyConnection();
  }

  public getConnection(): Connection {
    return this.proxyConnection;
  }

  public getActiveEndpoint(): string {
    return this.endpoints[this.activeIndex] ?? this.endpoints[0]!;
  }

  public getAllEndpoints(): readonly string[] {
    return this.endpoints;
  }

  public onActiveEndpointChange(listener: ActiveEndpointChangeListener): () => void {
    this.endpointChangeListeners.add(listener);
    return () => {
      this.endpointChangeListeners.delete(listener);
    };
  }

  private notifyEndpointChange(change: ActiveEndpointChange): void {
    for (const listener of this.endpointChangeListeners) {
      try {
        const result = listener(change);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<unknown>).catch((error) => {
            this.logger?.error?.("RPC endpoint change listener failed:", error);
          });
        }
      } catch (error) {
        this.logger?.error?.("RPC endpoint change listener threw:", error);
      }
    }
  }

  private ensureConnection(index: number): Connection {
    let connection = this.connectionCache.get(index);
    if (!connection) {
      const endpoint = this.endpoints[index] ?? this.endpoints[0]!;
      connection = this.connectionFactory(endpoint, this.commitment);
      this.connectionCache.set(index, connection);
    }
    return connection;
  }

  private promote(index: number): void {
    if (this.activeIndex === index) {
      return;
    }
    const previousIndex = this.activeIndex;
    const previousEndpoint = this.endpoints[previousIndex] ?? this.endpoints[0]!;
    this.activeIndex = index;
    this.logger?.info?.(
      `Switched Solana RPC endpoint to ${this.endpoints[index]} (commitment=${this.commitment})`,
    );
    this.notifyEndpointChange({
      endpoint: this.endpoints[index] ?? this.endpoints[0]!,
      index,
      previousEndpoint,
      previousIndex,
    });
  }

  private createProxyConnection(): Connection {
    const initialConnection = this.ensureConnection(this.activeIndex);
    const handler: ProxyHandler<Connection> = {
      get: (_target, prop, receiver) => {
        if (prop === Symbol.toStringTag) {
          return "Connection";
        }

        if (prop === "rpcEndpoint") {
          return this.getActiveEndpoint();
        }

        if (prop === "commitment") {
          return this.commitment;
        }

        const connection = this.ensureConnection(this.activeIndex);
        const value = Reflect.get(connection, prop, receiver);

        if (typeof value !== "function") {
          return value;
        }

        return (...args: unknown[]) => this.invokeWithFallback(prop, args);
      },
      set: (_target, prop, value) => {
        const connection = this.ensureConnection(this.activeIndex);
        Reflect.set(connection, prop, value);
        return true;
      },
    };

    return new Proxy(initialConnection, handler);
  }

  private shouldRetryRpcCall(
    error: unknown,
    methodName: string,
    endpoint: string,
    attempt: number,
    total: number,
  ): boolean {
    if (!isRetryableRpcError(error) || total === 1 || attempt >= total - 1) {
      this.logger?.error?.(`RPC call ${methodName} failed on ${endpoint} without fallback:`, error);
      return false;
    }

    this.logger?.warn?.(
      `RPC call ${methodName} failed on ${endpoint}; trying next endpoint (${attempt + 1}/${total}).`,
    );
    return true;
  }

  private invokeWithFallback(prop: string | symbol, args: unknown[]): unknown {
    const total = this.endpoints.length;
    const methodName = typeof prop === "symbol" ? prop.toString() : prop;
    let lastError: unknown;

    const attemptCall = (offset: number): unknown => {
      if (offset >= total) {
        throw lastError ?? new Error("RPC invocation failed without specific error");
      }

      const index = (this.activeIndex + offset) % total;
      const connection = this.ensureConnection(index);
      const method = Reflect.get(connection, prop, connection);

      if (typeof method !== "function") {
        return method;
      }

      const endpoint = this.endpoints[index] ?? this.endpoints[0]!;
      const handleFailure = (error: unknown): unknown => {
        lastError = error;
        if (!this.shouldRetryRpcCall(error, methodName, endpoint, offset, total)) {
          throw error;
        }
        return attemptCall(offset + 1);
      };

      try {
        const result = method.apply(connection, args);

        if (!isPromiseLike(result)) {
          this.promote(index);
          return result;
        }

        return Promise.resolve(result)
          .then((value) => {
            this.promote(index);
            return value;
          })
          .catch(handleFailure);
      } catch (error) {
        return handleFailure(error);
      }
    };

    return attemptCall(0);
  }
}

export function parseRpcEndpointList(
  value: string | undefined,
  options: { fallback?: string | string[] } = {},
): string[] {
  const { fallback } = options;
  const fallbackList =
    typeof fallback === "string"
      ? [fallback]
      : Array.isArray(fallback)
        ? fallback.filter((item) => item && item.trim().length > 0)
        : [];

  if (!value || value.trim().length === 0) {
    if (fallbackList.length === 0) {
      throw new Error("SOLANA_NETWORK is required");
    }
    return fallbackList;
  }

  const trimmed = value.trim();
  let parsed: unknown;

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Failed to parse SOLANA_NETWORK JSON array: ${error}`);
    }
  }

  let endpoints: string[];
  if (Array.isArray(parsed)) {
    endpoints = parsed.map((item) => String(item ?? ""));
  } else if (typeof parsed === "undefined") {
    endpoints = trimmed
      .split(",")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
  } else {
    endpoints = [String(parsed)];
  }

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    const normalized = endpoint.trim();
    if (!normalized) {
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }

  if (unique.length === 0) {
    if (fallbackList.length > 0) {
      return fallbackList;
    }
    throw new Error("SOLANA_NETWORK resolved to an empty list");
  }

  return unique;
}

export function resolvePrimaryRpcEndpoint(
  value: string | undefined,
  fallback: string | string[] = DEFAULT_MAINNET_ENDPOINT,
): string {
  const endpoints = parseRpcEndpointList(value, { fallback });
  return endpoints[0]!;
}
