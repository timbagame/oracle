import type { FakeOracleOptions } from "./fake-oracle.ts";
import { createBasicOracle } from "./fake-oracle.ts";
import { createTestEnv } from "./create-test-env.ts";

const DEFAULT_TEST_BASE_URL = "http://localhost:3001";

type IndexModule = typeof import("../../index.ts");
type Router = ReturnType<IndexModule["buildFetchRouter"]>;
type Handlers = ReturnType<IndexModule["buildHandlers"]>;
type RouteMetadata = typeof import("../../index.ts").ROUTE_METADATA;

export interface IndexRouterTestContext {
  testEnv: Awaited<ReturnType<typeof createTestEnv>>;
  module: IndexModule;
  handlers: Handlers;
  router: Router;
  routeMetadata: RouteMetadata;
}

export interface IndexLifecycleContext {
  testEnv: Awaited<ReturnType<typeof createTestEnv>>;
  initialize: IndexModule["initialize"];
  shutdown: IndexModule["shutdown"];
}

export async function createIndexRouterTestContext(
  prefix: string,
  oracleOptions: FakeOracleOptions = {},
): Promise<IndexRouterTestContext> {
  const testEnv = await createTestEnv({ prefix });
  const module = await import("../../index.ts");
  const handlers = module.buildHandlers(createBasicOracle(oracleOptions));
  const router = module.buildFetchRouter(handlers);
  return {
    testEnv,
    module,
    handlers,
    router,
    routeMetadata: module.ROUTE_METADATA,
  };
}

export async function createIndexLifecycleContext(
  prefix: string,
): Promise<IndexLifecycleContext> {
  const testEnv = await createTestEnv({ prefix });
  const module = await import("../../index.ts");
  return {
    testEnv,
    initialize: module.initialize,
    shutdown: module.shutdown,
  };
}

export function buildRequest(
  path: string,
  init?: RequestInit,
  baseUrl = DEFAULT_TEST_BASE_URL,
): Request {
  return new Request(`${baseUrl}${path}`, init);
}

export async function executeJsonRequest(
  router: Router,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; json: unknown }> {
  const response = await router(buildRequest(path, init));
  const json = await response.json();
  return { response, json };
}

export async function executeTextRequest(
  router: Router,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; text: string }> {
  const response = await router(buildRequest(path, init));
  const text = await response.text();
  return { response, text };
}
