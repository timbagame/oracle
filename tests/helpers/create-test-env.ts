import { setupTestEnvironment } from "./setup-env.ts";

export type TestEnvironment = ReturnType<typeof setupTestEnvironment>;
export type SingletonModule = Parameters<TestEnvironment["registerSingleton"]>[0];
export type SingletonLoader<TSingleton extends SingletonModule> = () => Promise<TSingleton>;
export type SingletonLoaderMap = Record<string, SingletonLoader<SingletonModule>>;
export type CreateTestEnvResult<TLoaders extends SingletonLoaderMap> = TestEnvironment & {
  singletons: {
    [K in keyof TLoaders]: Awaited<ReturnType<TLoaders[K]>>;
  };
};

export async function createTestEnv<TLoaders extends SingletonLoaderMap>(options: {
  prefix: string;
  singletons?: TLoaders;
  env?: Record<string, string | undefined>;
}): Promise<CreateTestEnvResult<TLoaders>> {
  const testEnv = setupTestEnvironment({ prefix: options.prefix, env: options.env });

  const singletonsEntries: [string, SingletonModule][] = [];
  if (options.singletons) {
    for (const [key, loader] of Object.entries(options.singletons)) {
      const singleton = await loader();
      testEnv.registerSingleton(singleton);
      singletonsEntries.push([key, singleton]);
    }
  }

  const singletons = Object.fromEntries(
    singletonsEntries,
  ) as CreateTestEnvResult<TLoaders>["singletons"];

  return Object.assign(testEnv, { singletons });
}
