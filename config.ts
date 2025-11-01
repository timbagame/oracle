import * as path from "path";
import { getEnvironmentMode, readEnv, shouldUseEphemeralKeypair } from "./env.ts";

const DEFAULT_PORT = 3001;
const DEFAULT_DATABASE_FILE = "oracle.sqlite";
const DEFAULT_KEYPAIR_FILE = "admin-keypair.json";

function parseInteger(
  value: string | undefined,
  {
    defaultValue,
    min,
    max,
    key,
  }: { defaultValue: number; min?: number; max?: number; key: string }
): number {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    console.warn(
      `⚠️  Ignoring invalid numeric value '${value}' for ${key}; using ${defaultValue}.`
    );
    return defaultValue;
  }

  if (!Number.isInteger(parsed)) {
    console.warn(
      `⚠️  ${key} must be an integer, received ${parsed}; using ${defaultValue}.`
    );
    return defaultValue;
  }

  if (min !== undefined && parsed < min) {
    console.warn(
      `⚠️  ${key} must be >= ${min}, received ${parsed}; using ${defaultValue}.`
    );
    return defaultValue;
  }

  if (max !== undefined && parsed > max) {
    console.warn(
      `⚠️  ${key} must be <= ${max}, received ${parsed}; using ${defaultValue}.`
    );
    return defaultValue;
  }

  return parsed;
}

function parseNonNegative(
  value: string | undefined,
  { defaultValue, key }: { defaultValue: number; key: string }
): number {
  const parsed = parseInteger(value, { defaultValue, min: 0, key });
  if (parsed < 0) {
    return defaultValue;
  }
  return parsed;
}

function resolvePath(relativeOrAbsolute: string): string {
  return path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.join(process.cwd(), relativeOrAbsolute);
}

export interface OracleRuntimeConfig {
  readonly solanaNetwork: string;
  readonly oraclePort: number;
  readonly databaseFile: string;
  readonly adminKeypairPath: string;
  readonly adminKeypairSource: string;
  readonly scanThrottleMs: number;
  readonly useEphemeralKeypair: boolean;
  readonly environment: string;
}

let cachedConfig: OracleRuntimeConfig | null = null;

function loadConfig(): OracleRuntimeConfig {
  const environment = getEnvironmentMode();
  const solanaNetwork = readEnv("SOLANA_NETWORK");

  if (!solanaNetwork) {
    throw new Error("SOLANA_NETWORK environment variable is required");
  }

  const databaseFile = readEnv("DATABASE_FILE") ?? DEFAULT_DATABASE_FILE;
  const adminKeypairSource = readEnv("ORACLE_KEYPAIR_PATH") ?? DEFAULT_KEYPAIR_FILE;
  const adminKeypairPath = resolvePath(adminKeypairSource);

  const oraclePort = parseInteger(readEnv("ORACLE_PORT"), {
    defaultValue: DEFAULT_PORT,
    min: 0,
    max: 65535,
    key: "ORACLE_PORT",
  });

  const scanThrottleMs = parseNonNegative(readEnv("ORACLE_SCAN_THROTTLE_MS"), {
    defaultValue: 0,
    key: "ORACLE_SCAN_THROTTLE_MS",
  });

  const useEphemeralKeypair = shouldUseEphemeralKeypair();

  return {
    solanaNetwork,
    oraclePort,
    databaseFile,
    adminKeypairPath,
    adminKeypairSource,
    scanThrottleMs,
    useEphemeralKeypair,
    environment,
  } as const;
}

export function getConfig(): OracleRuntimeConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

export function resetConfigForTesting(): void {
  cachedConfig = null;
}
