import * as anchor from "@anchor-lang/core";
import type { Commitment } from "@solana/web3.js";

import { delay } from "./delay.ts";

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
  delayFn?: (ms: number) => Promise<void>;
}

export interface ActiveEndpointChange {
  endpoint: string;
  index: number;
  previousEndpoint: string;
  previousIndex: number;
}

type ActiveEndpointChangeListener = (change: ActiveEndpointChange) => void | Promise<void>;

export const DEFAULT_MAINNET_ENDPOINT = "https://api.mainnet-beta.solana.com";
export const RPC_RETRY_BASE_DELAY_MS = 500;
const RPC_RETRY_MAX_DELAY_MS = 30_000;

export function normalizeRpcEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.replace(/\/+$/, "");
}
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

type HeadersLike = {
  get?: (name: string) => string | null;
  [key: string]: unknown;
};

function extractHeaders(error: unknown): HeadersLike | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const withHeaders = error as { headers?: HeadersLike; response?: { headers?: HeadersLike } };
  if (withHeaders.headers) {
    return withHeaders.headers;
  }
  return withHeaders.response?.headers;
}

function readHeader(headers: HeadersLike | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (typeof headers.get === "function") {
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  }

  const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  if (!matchingKey) {
    return undefined;
  }

  const value = headers[matchingKey];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }

  return undefined;
}

function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const withStatus = error as {
    status?: number;
    statusCode?: number;
    code?: number | string;
    response?: { status?: number };
  };

  if (typeof withStatus.status === "number") {
    return withStatus.status;
  }
  if (typeof withStatus.statusCode === "number") {
    return withStatus.statusCode;
  }
  if (typeof withStatus.response?.status === "number") {
    return withStatus.response.status;
  }
  if (typeof withStatus.code === "number") {
    return withStatus.code;
  }
  if (typeof withStatus.code === "string") {
    const parsed = Number(withStatus.code);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function isRateLimitError(error: unknown): boolean {
  const statusCode = extractStatusCode(error);
  if (statusCode === 429) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\b429\b/.test(message);
}

function getRetryAfterMs(error: unknown): number | undefined {
  const headers = extractHeaders(error);
  if (!headers) {
    return undefined;
  }

  return parseRetryAfterMs(readHeader(headers, "retry-after"));
}

function computeRetryDelayMs(attempt: number, retryAfterMs?: number): number {
  const exponent = Math.min(attempt, 6);
  const baseDelay = RPC_RETRY_BASE_DELAY_MS * 2 ** exponent;
  const jitter = Math.random() * RPC_RETRY_BASE_DELAY_MS;
  const computedDelay = Math.min(RPC_RETRY_MAX_DELAY_MS, baseDelay + jitter);

  if (typeof retryAfterMs === "number") {
    return Math.max(retryAfterMs, computedDelay);
  }

  return computedDelay;
}

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
  private readonly delayFn: (ms: number) => Promise<void>;
  private readonly connectionCache = new Map<number, Connection>();
  private readonly proxyConnection: Connection;
  private activeIndex = 0;
  private readonly endpointChangeListeners = new Set<ActiveEndpointChangeListener>();

  constructor(endpointsInput: readonly string[], options: RpcEndpointManagerOptions = {}) {
    const endpoints = Array.isArray(endpointsInput) ? Array.from(endpointsInput) : [];
    if (endpoints.length === 0) {
      throw new Error("At least one RPC endpoint is required");
    }

    this.endpoints = Array.from(new Set(endpoints.map((url) => normalizeRpcEndpoint(url)))).filter(
      (url) => url.length > 0,
    );

    if (this.endpoints.length === 0) {
      throw new Error("SOLANA_NETWORK did not resolve to any RPC endpoints");
    }

    this.commitment = options.commitment ?? DEFAULT_COMMITMENT;
    this.logger = options.logger;
    this.connectionFactory =
      options.connectionFactory ??
      ((endpoint: string, commitment: Commitment) =>
        new anchor.web3.Connection(endpoint, commitment));
    this.delayFn = options.delayFn ?? delay;
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

  private async notifyEndpointChange(change: ActiveEndpointChange): Promise<void> {
    const listeners = Array.from(this.endpointChangeListeners);
    await Promise.all(
      listeners.map(async (listener) => {
        try {
          await listener(change);
        } catch (error) {
          this.logger?.error?.("RPC endpoint change listener failed:", error);
        }
      }),
    );
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

  private async promote(index: number): Promise<void> {
    if (this.activeIndex === index) {
      return;
    }
    const previousIndex = this.activeIndex;
    const previousEndpoint = this.endpoints[previousIndex] ?? this.endpoints[0]!;
    const endpoint = this.endpoints[index] ?? this.endpoints[0]!;

    this.activeIndex = index;

    await this.notifyEndpointChange({
      endpoint,
      index,
      previousEndpoint,
      previousIndex,
    });
    this.logger?.info?.(
      `Switched Solana RPC endpoint to ${endpoint} (commitment=${this.commitment})`,
    );
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
  ): { shouldRetry: boolean; delayMs?: number } {
    if (!isRetryableRpcError(error) || total === 1 || attempt >= total - 1) {
      this.logger?.error?.(`RPC call ${methodName} failed on ${endpoint} without fallback:`, error);
      return { shouldRetry: false };
    }

    if (isRateLimitError(error)) {
      const retryAfterMs = getRetryAfterMs(error);
      const delayMs = computeRetryDelayMs(attempt, retryAfterMs);
      this.logger?.warn?.(
        `RPC call ${methodName} rate limited on ${endpoint}; waiting ${Math.round(
          delayMs,
        )}ms before retrying (${attempt + 1}/${total}).`,
      );
      return { shouldRetry: true, delayMs };
    }

    this.logger?.warn?.(
      `RPC call ${methodName} failed on ${endpoint}; trying next endpoint (${attempt + 1}/${total}).`,
    );
    return { shouldRetry: true };
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
        const decision = this.shouldRetryRpcCall(error, methodName, endpoint, offset, total);
        if (!decision.shouldRetry) {
          throw error;
        }
        if (decision.delayMs && decision.delayMs > 0) {
          return this.delayFn(decision.delayMs).then(() => attemptCall(offset + 1));
        }
        return attemptCall(offset + 1);
      };

      try {
        const result = method.apply(connection, args);

        if (!isPromiseLike(result)) {
          void this.promote(index);
          return result;
        }

        return Promise.resolve(result)
          .then((value) => {
            void this.promote(index);
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
    const normalized = normalizeRpcEndpoint(endpoint);
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
