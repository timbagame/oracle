import { createTempDatabaseFile, type TempDatabaseFile } from "./test-db.ts";
import { resetConfigForTesting } from "../../config.ts";
import { setOracleEnvironment } from "../../env.ts";

type SingletonModule = { [key: string]: unknown } | Function;

type SetupOptions = {
  prefix?: string;
  env?: Record<string, string | undefined>;
};

type SetupResult = {
  tempDb: TempDatabaseFile;
  registerSingleton: (singleton: SingletonModule) => void;
  resetSingletons: () => void;
  cleanup: () => void;
};

function resetSingleton(singleton: SingletonModule) {
  if (!singleton) {
    return;
  }

  const target = singleton as {
    instance?: { close?: () => void } | undefined;
  };

  const { instance } = target;
  if (instance && typeof instance.close === "function") {
    try {
      instance.close();
    } catch {
      // ignore errors while closing during test cleanup
    }
  }

  if ("instance" in target) {
    target.instance = undefined;
  }
}

export function setupTestEnvironment(options: SetupOptions = {}): SetupResult {
  const tempDb = createTempDatabaseFile(options.prefix ?? "test-db");
  const additionalEnv = { ...options.env };
  const registeredSingletons = new Set<SingletonModule>();
  let cleanedUp = false;

  const nodeEnv = additionalEnv["NODE_ENV"] ?? "test";
  delete additionalEnv["NODE_ENV"];

  const solanaNetwork =
    additionalEnv["SOLANA_NETWORK"] ?? process.env["SOLANA_NETWORK"] ?? "http://localhost";
  delete additionalEnv["SOLANA_NETWORK"];

  const restoreOracleEnv = setOracleEnvironment({
    nodeEnv,
    solanaNetwork,
    databaseFile: tempDb.path,
    additional: additionalEnv,
  });

  resetConfigForTesting();

  const registerSingleton = (singleton: SingletonModule) => {
    if (!singleton) {
      return;
    }
    registeredSingletons.add(singleton);
    resetSingleton(singleton);
    resetConfigForTesting();
  };

  const resetSingletons = () => {
    for (const singleton of registeredSingletons) {
      resetSingleton(singleton);
    }
  };

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    resetSingletons();
    tempDb.cleanup();

    restoreOracleEnv();
    resetConfigForTesting();
  };

  return { tempDb, registerSingleton, resetSingletons, cleanup };
}
