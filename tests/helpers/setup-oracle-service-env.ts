import { OracleDatabase } from "../../database.ts";
import { OracleService } from "../../oracle-service.ts";
import { createTestEnv } from "./create-test-env.ts";

export type OracleServiceClass = typeof OracleService;
export type OracleDatabaseClass = typeof OracleDatabase;

export async function setupOracleServiceEnv(prefix: string): Promise<{
  OracleService: OracleServiceClass;
  OracleDatabase: OracleDatabaseClass;
  cleanup: () => void;
}> {
  const env = await createTestEnv({
    prefix,
    singletons: {
      OracleService: async () => OracleService,
      OracleDatabase: async () => OracleDatabase,
    },
    // Explicitly set SOLANA_NETWORK to prevent CI environment overrides
    env: {
      SOLANA_NETWORK: "http://localhost",
    },
  });

  return {
    OracleService: env.singletons.OracleService,
    OracleDatabase: env.singletons.OracleDatabase,
    cleanup: env.cleanup,
  };
}
