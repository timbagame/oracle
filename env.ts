const ENV_KEYS = ["NODE_ENV", "BUN_ENV"] as const;

export function readEnv(key: string): string | undefined {
  const value = process.env[key];
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function applyEnvUpdates(updates: Record<string, string | undefined>): () => void {
  const originalValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(updates)) {
    originalValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export interface OracleEnvironmentOptions {
  nodeEnv?: string;
  solanaNetwork?: string;
  databaseFile?: string;
  fallbackSolanaNetwork?: string;
  additional?: Record<string, string | undefined>;
}

export function setOracleEnvironment(options: OracleEnvironmentOptions = {}): () => void {
  const {
    nodeEnv,
    solanaNetwork,
    databaseFile,
    fallbackSolanaNetwork = "http://localhost",
    additional = {},
  } = options;

  const updates: Record<string, string | undefined> = { ...additional };

  if (nodeEnv !== undefined) {
    updates["NODE_ENV"] = nodeEnv;
  }

  const resolvedSolanaNetwork =
    solanaNetwork ?? readEnv("SOLANA_NETWORK") ?? fallbackSolanaNetwork;
  updates["SOLANA_NETWORK"] = resolvedSolanaNetwork;

  if (databaseFile !== undefined) {
    updates["DATABASE_FILE"] = databaseFile;
  }

  return applyEnvUpdates(updates);
}

export function isCiEnvironment(): boolean {
  return process.env["CI"] === "true";
}

export function getEnvironmentMode(): string {
  for (const key of ENV_KEYS) {
    const value = readEnv(key);
    if (value) {
      return value;
    }
  }

  if (isCiEnvironment()) {
    return "ci";
  }

  return "development";
}

export function isTestEnvironment(): boolean {
  const mode = getEnvironmentMode().toLowerCase();
  return mode === "test" || mode.includes("test");
}

export function shouldUseEphemeralKeypair(): boolean {
  if (isTestEnvironment()) {
    return true;
  }

  if (isCiEnvironment()) {
    return true;
  }

  return process.env["USE_FAKE_KEYPAIR"] === "true";
}
