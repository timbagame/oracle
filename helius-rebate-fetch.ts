const HELIUS_HOSTNAME_PATTERN = /(^|\.)helius-rpc\.com$/i;
const BODY_DECODER = new TextDecoder();

function isHeliusHostname(hostname: string): boolean {
  return HELIUS_HOSTNAME_PATTERN.test(hostname);
}

function normalizeBody(body: unknown): string | undefined {
  if (typeof body === "string") {
    return body;
  }

  if (body instanceof Uint8Array) {
    return BODY_DECODER.decode(body);
  }

  if (body instanceof ArrayBuffer) {
    return BODY_DECODER.decode(new Uint8Array(body));
  }

  return undefined;
}

function extractRpcMethod(body: unknown): string | undefined {
  const normalized = normalizeBody(body);
  if (!normalized) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === "object" && typeof parsed.method === "string") {
      return parsed.method;
    }
  } catch {
    // Ignore invalid JSON
  }

  return undefined;
}

export function createRebateAwareFetch(
  baseFetch: typeof fetch,
  rebateAddress?: string,
): typeof fetch {
  const normalizedRebate = rebateAddress?.trim();
  if (!normalizedRebate) {
    return baseFetch;
  }

  const rebateFetch = (async (
    input: string | URL | Request,
    init?: RequestInit | BunFetchRequestInit,
  ) => {
    const rpcMethod = extractRpcMethod(init?.body);
    let requestInput: RequestInfo =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input;
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (rpcMethod === "sendTransaction" && rawUrl) {
      const url = new URL(rawUrl);
      if (isHeliusHostname(url.hostname)) {
        url.searchParams.set("rebate-address", normalizedRebate);
        requestInput = url.toString();
      }
    }

    return baseFetch(requestInput, init);
  }) as typeof fetch;

  rebateFetch.preconnect = baseFetch.preconnect;
  return rebateFetch;
}
