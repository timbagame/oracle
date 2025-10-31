import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "path";
import { getEnvironmentMode, isTestEnvironment, shouldUseEphemeralKeypair } from "../env.ts";
import { getConfig, resetConfigForTesting } from "../config.ts";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.NODE_ENV;
  delete process.env.BUN_ENV;
  delete process.env.CI;
  delete process.env.USE_FAKE_KEYPAIR;
  delete process.env.SOLANA_NETWORK;
  delete process.env.ORACLE_PORT;
  delete process.env.ORACLE_SCAN_THROTTLE_MS;
  delete process.env.DATABASE_FILE;
  delete process.env.ORACLE_KEYPAIR_PATH;
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
    process.env.BUN_ENV = "   ";
    process.env.CI = "false";

    expect(getEnvironmentMode()).toBe("production");
    expect(isTestEnvironment()).toBe(false);
    expect(shouldUseEphemeralKeypair()).toBe(false);
  });

  it("detects CI/test environments when explicit mode is absent", () => {
    process.env.CI = "true";
    expect(getEnvironmentMode()).toBe("ci");
    expect(isTestEnvironment()).toBe(false);
    expect(shouldUseEphemeralKeypair()).toBe(true);

    resetEnv();
    process.env.BUN_ENV = "integration-test";
    expect(isTestEnvironment()).toBe(true);
    expect(shouldUseEphemeralKeypair()).toBe(true);
  });

  it("allows opting into ephemeral keypairs via USE_FAKE_KEYPAIR", () => {
    process.env.NODE_ENV = "production";
    process.env.USE_FAKE_KEYPAIR = "true";
    expect(shouldUseEphemeralKeypair()).toBe(true);
  });
});

describe("runtime config", () => {
  it("throws when SOLANA_NETWORK is missing", () => {
    expect(() => getConfig()).toThrow("SOLANA_NETWORK environment variable is required");
  });

  it("normalizes numeric inputs and enforces bounds", () => {
    process.env.SOLANA_NETWORK = "https://rpc";
    process.env.ORACLE_PORT = "70000";
    process.env.ORACLE_SCAN_THROTTLE_MS = "-5";
    const warnSpy = spyOn(console, "warn");

    const config = getConfig();
    expect(config.oraclePort).toBe(3001);
    expect(config.scanThrottleMs).toBe(0);

    expect(warnSpy).toHaveBeenCalledWith(
      "⚠️  ORACLE_PORT must be <= 65535, received 70000; using 3001."
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "⚠️  ORACLE_SCAN_THROTTLE_MS must be >= 0, received -5; using 0."
    );

    warnSpy.mockRestore();
  });

  it("resolves relative paths and caches results until reset", () => {
    process.env.SOLANA_NETWORK = "https://rpc";
    process.env.ORACLE_KEYPAIR_PATH = "keys/admin.json";
    process.env.DATABASE_FILE = "./db/oracle.sqlite";

    const first = getConfig();
    const expectedKeypair = path.join(process.cwd(), "keys/admin.json");
    const expectedDb = "./db/oracle.sqlite";

    expect(first.adminKeypairPath).toBe(expectedKeypair);
    expect(first.databaseFile).toBe(expectedDb);

    process.env.DATABASE_FILE = "ignored.sqlite";
    const cached = getConfig();
    expect(cached.databaseFile).toBe(expectedDb);

    resetConfigForTesting();
    const refreshed = getConfig();
    expect(refreshed.databaseFile).toBe("ignored.sqlite");
  });
});
