import { createTestEnv } from "./create-test-env.ts";
import type { EnvValue } from "./setup-env.ts";

export type OracleServiceClass = typeof import("../../oracle-service.ts").OracleService;
export type OracleDatabaseClass = typeof import("../../database.ts").OracleDatabase;

export async function setupOracleServiceEnv(
  prefix: string,
  options: { env?: Record<string, EnvValue> } = {}
): Promise<{
  OracleService: OracleServiceClass;
  OracleDatabase: OracleDatabaseClass;
  cleanup: () => void;
}> {
  const env = await createTestEnv({
    prefix,
    env: options.env,
    singletons: {
      OracleService: async () => (await import("../../oracle-service.ts")).OracleService,
      OracleDatabase: async () => (await import("../../database.ts")).OracleDatabase,
    },
  });

  return {
    OracleService: env.singletons.OracleService,
    OracleDatabase: env.singletons.OracleDatabase,
    cleanup: env.cleanup,
  };
}
