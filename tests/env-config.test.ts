import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "path";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { getEnvironmentMode, isTestEnvironment, shouldUseEphemeralKeypair } from "../env.ts";
import { getConfig, resetConfigForTesting } from "../config.ts";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  const keys: Array<keyof NodeJS.ProcessEnv> = [
    "NODE_ENV",
    "BUN_ENV",
    "CI",
    "USE_FAKE_KEYPAIR",
    "SOLANA_NETWORK",
    "ORACLE_PORT",
    "ORACLE_SCAN_THROTTLE_MS",
    "ORACLE_PLAYER_EVENT_FLUSH_DEBOUNCE_MS",
    "ORACLE_PLAYER_EVENT_FLUSH_MAX_OPERATIONS",
    "ORACLE_AUTOCOMPLETE_DEBOUNCE_MS",
    "ORACLE_DISABLE_RPC_BATCH_TRANSACTIONS",
    "DATABASE_FILE",
    "OPERATOR_KEYPAIR_PATH",
    "ORACLE_KEYPAIR_PATH",
    "ORACLE_API_TOKEN",
    "ORACLE_API_TOKEN_FILE",
  ];
  for (const key of keys) {
    delete process.env[key];
  }
}

beforeEach(() => {
  resetEnv();
  resetConfigForTesting();
});

afterEach(() => {
  resetEnv();
  resetConfigForTesting();
});

describe("environment helpers", () => {
  it("prefers explicit runtime env variables over CI defaults", () => {
    process.env.NODE_ENV = " production ";
    process.env["BUN_ENV"] = "   ";
    process.env["CI"] = "false";

    expect(getEnvironmentMode()).toBe("production");
    expect(isTestEnvironment()).toBe(false);
    expect(shouldUseEphemeralKeypair()).toBe(false);
  });

  it("detects CI/test environments when explicit mode is absent", () => {
    process.env["CI"] = "true";
    expect(getEnvironmentMode()).toBe("ci");
    expect(isTestEnvironment()).toBe(false);
    expect(shouldUseEphemeralKeypair()).toBe(true);

    resetEnv();
    process.env["BUN_ENV"] = "integration-test";
    expect(isTestEnvironment()).toBe(true);
    expect(shouldUseEphemeralKeypair()).toBe(true);
  });

  it("allows opting into ephemeral keypairs via USE_FAKE_KEYPAIR", () => {
    process.env.NODE_ENV = "production";
    process.env["USE_FAKE_KEYPAIR"] = "true";
    expect(shouldUseEphemeralKeypair()).toBe(true);
  });

  it("allows opting out of ephemeral keypairs via USE_FAKE_KEYPAIR=false", () => {
    process.env["CI"] = "true";
    process.env["USE_FAKE_KEYPAIR"] = "false";
    expect(shouldUseEphemeralKeypair()).toBe(false);

    resetEnv();
    process.env["NODE_ENV"] = "test";
    process.env["USE_FAKE_KEYPAIR"] = "false";
    expect(shouldUseEphemeralKeypair()).toBe(false);
  });
});

describe("runtime config", () => {
  it("throws when SOLANA_NETWORK is missing", () => {
    expect(() => getConfig()).toThrow("SOLANA_NETWORK is required");
  });

  it("normalizes numeric inputs and enforces bounds", () => {
    process.env["SOLANA_NETWORK"] = "https://rpc";
    process.env["ORACLE_PORT"] = "70000";
    process.env["ORACLE_SCAN_THROTTLE_MS"] = "-5";
    process.env["ORACLE_PLAYER_EVENT_FLUSH_DEBOUNCE_MS"] = "-1";
    process.env["ORACLE_PLAYER_EVENT_FLUSH_MAX_OPERATIONS"] = "0";
    process.env["ORACLE_AUTOCOMPLETE_DEBOUNCE_MS"] = "not-a-number";
    const warnSpy = spyOn(console, "warn");

    const config = getConfig();
    expect(config.oraclePort).toBe(3001);
    expect(config.scanThrottleMs).toBe(0);
    expect(config.playerEventFlushDebounceMs).toBe(100);
    expect(config.playerEventFlushMaxOperations).toBe(500);
    expect(config.autoCompleteDebounceMs).toBe(500);
    expect(config.disableBatchTransactions).toBe(false);

    expect(warnSpy).toHaveBeenCalledWith(
      "⚠️  ORACLE_PORT must be <= 65535, received 70000; using 3001.",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "⚠️  ORACLE_SCAN_THROTTLE_MS must be >= 0, received -5; using 0.",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "⚠️  ORACLE_PLAYER_EVENT_FLUSH_DEBOUNCE_MS must be >= 0, received -1; using 100.",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "⚠️  ORACLE_PLAYER_EVENT_FLUSH_MAX_OPERATIONS must be >= 1, received 0; using 500.",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "⚠️  Ignoring invalid numeric value 'not-a-number' for ORACLE_AUTOCOMPLETE_DEBOUNCE_MS; using 500.",
    );

    warnSpy.mockRestore();
  });

  it("supports disabling batch RPC requests via ORACLE_DISABLE_RPC_BATCH_TRANSACTIONS", () => {
    process.env["SOLANA_NETWORK"] = "https://rpc";
    process.env["ORACLE_DISABLE_RPC_BATCH_TRANSACTIONS"] = "true";
    expect(getConfig().disableBatchTransactions).toBe(true);

    resetConfigForTesting();
    process.env["ORACLE_DISABLE_RPC_BATCH_TRANSACTIONS"] = "false";
    expect(getConfig().disableBatchTransactions).toBe(false);
  });

  it("normalizes the shared API token", () => {
    process.env["SOLANA_NETWORK"] = "https://rpc";
    process.env["ORACLE_API_TOKEN"] = "  service-secret  ";
    expect(getConfig().apiToken).toBe("service-secret");

    resetConfigForTesting();
    process.env["ORACLE_API_TOKEN"] = "   ";
    expect(getConfig().apiToken).toBeNull();
  });

  it("loads the shared API token only from a protected regular file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oracle-secret-"));
    const file = path.join(dir, "token");
    try {
      writeFileSync(file, "service-secret\n", { mode: 0o600 });
      process.env["SOLANA_NETWORK"] = "https://rpc";
      process.env["ORACLE_API_TOKEN_FILE"] = file;
      expect(getConfig().apiToken).toBe("service-secret");

      resetConfigForTesting();
      chmodSync(file, 0o640);
      expect(() => getConfig()).toThrow("insecure permissions");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves relative paths and caches results until reset", () => {
    process.env["SOLANA_NETWORK"] = "https://rpc";
    process.env["OPERATOR_KEYPAIR_PATH"] = "keys/operator.json";
    process.env["DATABASE_FILE"] = "./db/oracle.sqlite";

    const first = getConfig();
    const expectedKeypair = path.join(process.cwd(), "keys/operator.json");
    const expectedDb = "./db/oracle.sqlite";

    expect(first.operatorKeypairPath).toBe(expectedKeypair);
    expect(first.databaseFile).toBe(expectedDb);

    process.env["DATABASE_FILE"] = "ignored.sqlite";
    const cached = getConfig();
    expect(cached.databaseFile).toBe(expectedDb);

    resetConfigForTesting();
    const refreshed = getConfig();
    expect(refreshed.databaseFile).toBe("ignored.sqlite");
  });

  it("supports ORACLE_KEYPAIR_PATH as a legacy alias", () => {
    process.env["SOLANA_NETWORK"] = "https://rpc";
    process.env["ORACLE_KEYPAIR_PATH"] = "keys/legacy.json";

    expect(getConfig().operatorKeypairPath).toBe(path.join(process.cwd(), "keys/legacy.json"));
  });

  it("supports multi-endpoint SOLANA_NETWORK definitions", () => {
    process.env["SOLANA_NETWORK"] = '["https://rpc-primary","https://rpc-secondary"]';
    const config = getConfig();
    expect(config.solanaNetwork).toBe("https://rpc-primary");
    expect(config.solanaNetworks).toEqual(["https://rpc-primary", "https://rpc-secondary"]);
  });
});
