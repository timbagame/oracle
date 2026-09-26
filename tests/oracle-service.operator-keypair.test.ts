import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { Keypair } from "./helpers/solana-fixtures.ts";
import { setupOracleServiceEnv } from "./helpers/setup-oracle-service-env.ts";
import { logger } from "../logger.ts";

type OracleServiceClass = typeof import("../oracle-service.ts").OracleService;
type OracleDatabaseClass = typeof import("../database.ts").OracleDatabase;

let OracleService: OracleServiceClass;
let OracleDatabase: OracleDatabaseClass;
let cleanup: () => void;

beforeAll(async () => {
  const env = await setupOracleServiceEnv("oracle-service-operator-keypair-test");
  ({ OracleService, OracleDatabase, cleanup } = env);
});

afterAll(() => {
  cleanup();
});

function writeKeypairFile(bytes: number[], mode = 0o600): string {
  const path = join(tmpdir(), `operator-keypair-${process.pid}-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(bytes));
  chmodSync(path, mode);
  return path;
}

describe("OracleService operator keypair loading", () => {
  test("loads an owner-only keypair file and logs its address", async () => {
    const keypair = Keypair.generate();
    const path = writeKeypairFile(Array.from(keypair.secretKey));
    const success = spyOn(logger, "success").mockImplementation(() => {});

    try {
      const loaded = await (OracleService as any).loadOperatorKeypair({
        operatorKeypairPath: path,
        operatorKeypairSource: path,
        useEphemeralKeypair: false,
      });

      expect(loaded.address).toBe(keypair.publicKey.toBase58());
      expect(success).toHaveBeenCalledWith(`Loaded operator keypair: ${loaded.address}`);
    } finally {
      success.mockRestore();
      rmSync(path, { force: true });
    }
  });

  test("refuses to start with an unreadable keypair when ephemeral keys are disabled", async () => {
    const path = writeKeypairFile([1, 2, 300]);
    const failure = spyOn(logger, "failure").mockImplementation(() => {});

    try {
      await expect(
        (OracleService as any).loadOperatorKeypair({
          operatorKeypairPath: path,
          operatorKeypairSource: "OPERATOR_KEYPAIR_PATH",
          useEphemeralKeypair: false,
        }),
      ).rejects.toThrow(
        "OPERATOR_KEYPAIR_PATH could not be loaded: Operator keypair file contains byte values outside the 0-255 range",
      );
      expect(failure).toHaveBeenCalledWith(
        `Failed to load operator keypair from ${path}:`,
        "Operator keypair file contains byte values outside the 0-255 range",
      );
    } finally {
      failure.mockRestore();
      rmSync(path, { force: true });
    }
  });
});

describe("OracleService program client", () => {
  test("reads events from the currently active RPC endpoint", async () => {
    const service = await OracleService.createWith(OracleDatabase.getInstance());
    const manager = (service as any).rpcEndpointManager;
    const endpoint = spyOn(manager, "getActiveEndpoint").mockReturnValue("https://rpc.example");

    try {
      expect((service as any).program.getRpcEndpoint()).toBe("https://rpc.example");
      expect(endpoint).toHaveBeenCalledTimes(1);
    } finally {
      endpoint.mockRestore();
    }
  });
});
