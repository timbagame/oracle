import * as path from "path";
import { getEnvironmentMode, readEnv, shouldUseEphemeralKeypair } from "./env.ts";
import { parseRpcEndpointList } from "./rpc-endpoints.ts";
import * as fs from "node:fs";
import { parseContractVersion, type ContractVersion } from "./contract-idl.ts";

export const DEFAULT_ORACLE_PORT = 3001;
const DEFAULT_DATABASE_FILE = "oracle.sqlite";
const DEFAULT_INDEXER_DATABASE_FILE = "indexer.sqlite";
const DEFAULT_KEYPAIR_FILE = "operator-keypair.json";
const LEGACY_KEYPAIR_FILE = "admin-keypair.json";

function parseInteger(
  value: string | undefined,
  {
    defaultValue,
    min,
    max,
    key,
  }: { defaultValue: number; min?: number; max?: number; key: string },
): number {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    console.warn(
      `⚠️  Ignoring invalid numeric value '${value}' for ${key}; using ${defaultValue}.`,
    );
    return defaultValue;
  }

  if (!Number.isInteger(parsed)) {
    console.warn(`⚠️  ${key} must be an integer, received ${parsed}; using ${defaultValue}.`);
    return defaultValue;
  }

  if (min !== undefined && parsed < min) {
    console.warn(`⚠️  ${key} must be >= ${min}, received ${parsed}; using ${defaultValue}.`);
    return defaultValue;
  }

  if (max !== undefined && parsed > max) {
    console.warn(`⚠️  ${key} must be <= ${max}, received ${parsed}; using ${defaultValue}.`);
    return defaultValue;
  }

  return parsed;
}

function parseNonNegative(
  value: string | undefined,
  { defaultValue, key }: { defaultValue: number; key: string },
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

function readProtectedSecret(filePath: string, label: string): string {
  const resolved = resolvePath(filePath);
  const stats = fs.lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink())
    throw new Error(`${label} must be a regular file, not a symlink`);
  if (stats.size <= 0 || stats.size > 4096) throw new Error(`${label} has an invalid size`);
  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0)
    throw new Error(`${label} has insecure permissions (${mode.toString(8)}); use 400 or 600`);
  const value = fs.readFileSync(resolved, "utf8").trim();
  if (!value) throw new Error(`${label} is empty`);
  return value;
}

export interface OracleRuntimeConfig {
  readonly contractVersion: ContractVersion;
  readonly solanaNetwork: string;
  readonly solanaNetworks: readonly string[];
  readonly oraclePort: number;
  readonly databaseFile: string;
  readonly indexerDatabaseFile: string;
  readonly indexerPollIntervalMs: number;
  readonly operatorKeypairPath: string;
  readonly operatorKeypairSource: string;
  readonly scanThrottleMs: number;
  readonly playerEventFlushDebounceMs: number;
  readonly playerEventFlushMaxOperations: number;
  readonly autoCompleteDebounceMs: number;
  readonly useEphemeralKeypair: boolean;
  readonly environment: string;
  readonly botInternalUrl: string | null;
  readonly apiToken: string | null;
  readonly jupiterApiKey: string | null;
}

let cachedConfig: OracleRuntimeConfig | null = null;

function loadConfig(): OracleRuntimeConfig {
  const environment = getEnvironmentMode();
  const solanaNetworks = parseRpcEndpointList(readEnv("SOLANA_NETWORK"));
  const solanaNetwork = solanaNetworks[0]!;

  const databaseFile = readEnv("DATABASE_FILE") ?? DEFAULT_DATABASE_FILE;
  const indexerDatabaseFile = readEnv("INDEXER_DATABASE_FILE") ?? DEFAULT_INDEXER_DATABASE_FILE;
  const configuredOperatorKeypair =
    readEnv("OPERATOR_KEYPAIR_PATH") ?? readEnv("ORACLE_KEYPAIR_PATH");
  const operatorKeypairSource = configuredOperatorKeypair
    ? configuredOperatorKeypair
    : fs.existsSync(resolvePath(DEFAULT_KEYPAIR_FILE))
      ? DEFAULT_KEYPAIR_FILE
      : LEGACY_KEYPAIR_FILE;
  const operatorKeypairPath = resolvePath(operatorKeypairSource);

  const oraclePort = parseInteger(readEnv("ORACLE_PORT"), {
    defaultValue: DEFAULT_ORACLE_PORT,
    min: 0,
    max: 65535,
    key: "ORACLE_PORT",
  });

  const scanThrottleMs = parseNonNegative(readEnv("ORACLE_SCAN_THROTTLE_MS"), {
    defaultValue: 0,
    key: "ORACLE_SCAN_THROTTLE_MS",
  });

  const playerEventFlushDebounceMs = parseNonNegative(
    readEnv("ORACLE_PLAYER_EVENT_FLUSH_DEBOUNCE_MS"),
    { defaultValue: 100, key: "ORACLE_PLAYER_EVENT_FLUSH_DEBOUNCE_MS" },
  );

  const playerEventFlushMaxOperations = parseInteger(
    readEnv("ORACLE_PLAYER_EVENT_FLUSH_MAX_OPERATIONS"),
    {
      defaultValue: 500,
      min: 1,
      key: "ORACLE_PLAYER_EVENT_FLUSH_MAX_OPERATIONS",
    },
  );

  const autoCompleteDebounceMs = parseNonNegative(readEnv("ORACLE_AUTOCOMPLETE_DEBOUNCE_MS"), {
    defaultValue: 500,
    key: "ORACLE_AUTOCOMPLETE_DEBOUNCE_MS",
  });

  const useEphemeralKeypair = shouldUseEphemeralKeypair();
  const botInternalUrl = readEnv("BOT_INTERNAL_URL") ?? "http://bot:3002";
  const apiTokenFile = readEnv("ORACLE_API_TOKEN_FILE")?.trim();
  const apiToken = apiTokenFile
    ? readProtectedSecret(apiTokenFile, "Oracle API token file")
    : readEnv("ORACLE_API_TOKEN")?.trim() || null;
  const jupiterApiKeyFile = readEnv("JUPITER_API_KEY_FILE")?.trim();
  const jupiterApiKey = jupiterApiKeyFile
    ? readProtectedSecret(jupiterApiKeyFile, "Jupiter API key file")
    : readEnv("JUPITER_API_KEY")?.trim() || null;
  const indexerPollIntervalMs = parseInteger(readEnv("INDEXER_POLL_INTERVAL_MS"), {
    defaultValue: 300_000,
    min: 5_000,
    key: "INDEXER_POLL_INTERVAL_MS",
  });

  return {
    contractVersion: parseContractVersion(readEnv("CONTRACT_VERSION")),
    solanaNetwork,
    solanaNetworks,
    oraclePort,
    databaseFile,
    indexerDatabaseFile,
    indexerPollIntervalMs,
    operatorKeypairPath,
    operatorKeypairSource,
    scanThrottleMs,
    playerEventFlushDebounceMs,
    playerEventFlushMaxOperations,
    autoCompleteDebounceMs,
    useEphemeralKeypair,
    environment,
    botInternalUrl,
    apiToken,
    jupiterApiKey,
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
